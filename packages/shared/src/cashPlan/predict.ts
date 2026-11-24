import { addDays, daysBetween } from './dates.js';

/**
 * `predictCycleDates` (A1 spec v9 §3): the next statement close and due date, when a simple rule explains every pair
 * of the latest run of at least three consecutive monthly cycles. The close is a fixed day of the month (clamped to the
 * month's length) with one weekend rule (none, back to Friday, forward to Monday); the due date is the close plus a fixed
 * number of days, or a fixed day of a fixed later month with its own weekend rule. Every rule that explains the run must
 * predict the same dates, or there is no prediction. A prediction is dates only, labelled predicted, and never red.
 */

export interface CycleDatePrediction {
  closingDate: string;
  dueDate: string;
  predicted: true;
}

type Shift = 'none' | 'back' | 'forward';
const SHIFTS: readonly Shift[] = ['none', 'back', 'forward'];

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

function dateIn(month: number, day: number): string {
  const year = Math.floor(month / 12);
  const m = month % 12;
  const last = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, m, Math.min(day, last))).toISOString().slice(0, 10);
}

function shifted(date: string, shift: Shift): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (shift === 'none' || (weekday !== 0 && weekday !== 6)) return date;
  if (shift === 'back') return addDays(date, weekday === 6 ? -1 : -2);
  return addDays(date, weekday === 6 ? 2 : 1);
}

export function predictCycleDates(history: ReadonlyArray<{ closingDate: string; dueDate: string | null }>): CycleDatePrediction | null {
  const pairs = history.filter((item): item is { closingDate: string; dueDate: string } => item.dueDate !== null)
    .slice().sort((a, b) => (a.closingDate < b.closingDate ? -1 : 1));
  // The latest run of cycles closing in consecutive months.
  let run = pairs.slice(-1);
  for (let i = pairs.length - 2; i >= 0; i--) {
    if (monthIndex(run[0].closingDate) - monthIndex(pairs[i].closingDate) !== 1) break;
    run = [pairs[i], ...run];
  }
  if (run.length < 3) return null;
  const first = monthIndex(run[0].closingDate);
  const closes = new Set<string>();
  const dues = new Set<string>();
  for (const offset of [-1, 0, 1]) {
    for (let day = 1; day <= 31; day++) {
      for (const shift of SHIFTS) {
        const closeOf = (i: number) => shifted(dateIn(first + offset + i, day), shift);
        if (!run.every((pair, i) => closeOf(i) === pair.closingDate)) continue;
        const nextClose = closeOf(run.length);
        closes.add(nextClose);
        const gaps = new Set(run.map((pair) => daysBetween(pair.closingDate, pair.dueDate)));
        if (gaps.size === 1) dues.add(addDays(nextClose, [...gaps][0]));
        for (let later = 0; later <= 2; later++) {
          for (let dueDay = 1; dueDay <= 31; dueDay++) {
            for (const dueShift of SHIFTS) {
              const dueOf = (i: number) => shifted(dateIn(first + offset + i + later, dueDay), dueShift);
              if (run.every((pair, i) => dueOf(i) === pair.dueDate)) dues.add(dueOf(run.length));
            }
          }
        }
      }
    }
  }
  if (closes.size !== 1 || dues.size !== 1) return null;
  const [closingDate] = closes;
  const [dueDate] = dues;
  return dueDate >= closingDate ? { closingDate, dueDate, predicted: true } : null;
}
