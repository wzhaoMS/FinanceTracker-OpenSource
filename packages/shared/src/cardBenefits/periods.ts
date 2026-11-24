import { MONTH_LABELS, firstDayOfMonth, lastDayOfMonth, monthNumber } from './dates.js';
import type { BenefitCadence } from './types.js';

/** One period of a benefit: inclusive first and last day, and its short name. */
export interface BenefitPeriodSpan {
  start: string;
  end: string;
  label: string;
}

const LENGTH = { month: 1, quarter: 3, half: 6, year: 12, years: 12 } as const;

/**
 * The month (1–12) periods are aligned to: January for calendar periods and
 * for once-per-several-years credits (shown by calendar year), the
 * anniversary month for cardmember periods; null when that is unknown.
 */
function anchorOf(cadence: BenefitCadence, anniversaryMonth: number | null): number | null {
  if (cadence.every === 'years' || cadence.basis === 'calendar') return 1;
  return anniversaryMonth !== null && Number.isInteger(anniversaryMonth) && anniversaryMonth >= 1 && anniversaryMonth <= 12
    ? anniversaryMonth
    : null;
}

function label(cadence: BenefitCadence, first: number, length: number): string {
  const month = first % 12;
  const year = Math.floor(first / 12);
  const range = () => `${MONTH_LABELS[month]}–${MONTH_LABELS[(month + length - 1) % 12]}`;
  if (length === 1) return MONTH_LABELS[month];
  const calendar = cadence.every === 'years' || cadence.basis === 'calendar';
  if (length === 12) {
    return calendar ? String(year) : `${MONTH_LABELS[month]} ${year} – ${MONTH_LABELS[(month + 11) % 12]} ${month === 0 ? year : year + 1}`;
  }
  if (length === 3 && calendar) return `Q${month / 3 + 1}`;
  return range();
}

function spanAt(cadence: BenefitCadence, index: number, anchor: number): BenefitPeriodSpan {
  const length = LENGTH[cadence.every];
  const first = index * length + (anchor - 1);
  return { start: firstDayOfMonth(first), end: lastDayOfMonth(first + length - 1), label: label(cadence, first, length) };
}

function indexOf(cadence: BenefitCadence, date: string, anchor: number): number {
  return Math.floor((monthNumber(date) - (anchor - 1)) / LENGTH[cadence.every]);
}

/** "Monthly", "Each cardmember year", "Once every 4½ years". */
export function cadenceLabel(cadence: BenefitCadence): string {
  if (cadence.every === 'years') {
    const years = cadence.months / 12;
    return `Once every ${Number.isInteger(years) ? years : `${Math.floor(years)}½`} years`;
  }
  if (cadence.every === 'year') return cadence.basis === 'calendar' ? 'Each calendar year' : 'Each cardmember year';
  const word = { month: 'Monthly', quarter: 'Quarterly', half: 'Twice a year' }[cadence.every];
  return cadence.basis === 'calendar' ? word : `${word} (cardmember year)`;
}

/**
 * The periods of `year`: the calendar year's months, quarters, halves or the
 * year itself; for cardmember periods, those of the cardmember year that
 * starts in `year`'s anniversary month. Null when the anniversary month is
 * needed and unknown. A once-per-several-years credit shows the calendar year.
 */
export function benefitYearSpans(cadence: BenefitCadence, year: number, anniversaryMonth: number | null): BenefitPeriodSpan[] | null {
  const anchor = anchorOf(cadence, anniversaryMonth);
  if (anchor === null) return null;
  const first = indexOf(cadence, firstDayOfMonth(year * 12 + anchor - 1), anchor);
  const count = 12 / LENGTH[cadence.every];
  return Array.from({ length: count }, (_, i) => spanAt(cadence, first + i, anchor));
}

/** The period containing `date`, or null when the anniversary month is needed and unknown. */
export function benefitSpanContaining(cadence: BenefitCadence, date: string, anniversaryMonth: number | null): BenefitPeriodSpan | null {
  const anchor = anchorOf(cadence, anniversaryMonth);
  return anchor === null ? null : spanAt(cadence, indexOf(cadence, date, anchor), anchor);
}

/** Consecutive periods from the one containing `from` through the one containing `to`. */
export function benefitSpansBetween(
  cadence: BenefitCadence,
  from: string,
  to: string,
  anniversaryMonth: number | null,
): BenefitPeriodSpan[] | null {
  const anchor = anchorOf(cadence, anniversaryMonth);
  if (anchor === null) return null;
  const spans: BenefitPeriodSpan[] = [];
  for (let index = indexOf(cadence, from, anchor), last = indexOf(cadence, to, anchor); index <= last; index += 1) {
    spans.push(spanAt(cadence, index, anchor));
  }
  return spans;
}
