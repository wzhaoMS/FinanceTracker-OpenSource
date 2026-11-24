import { describe, expect, it } from 'vitest';

import { metalsCloseOnOrBefore, metalsPriceStale } from '@finance-tracker/shared/metals-ledger';

import { METALS_PLAUSIBLE_CLOSES, metalsScreenClosesV2, metalsScreenClosesWithGuards } from './closeScreen.js';

// Synthetic closes only: invented prices on invented days.

const TODAY = '2030-06-03';

/** `count` weekdays from `from` on. */
function weekdays(from: string, count: number): string[] {
  const days: string[] = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); days.length < count; time += 86_400_000) {
    const day = new Date(time);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

const series = (from: string, closes: readonly string[]) => weekdays(from, closes.length).map((date, index) => ({ date, close: closes[index] }));
const repeat = (close: string, count: number) => Array.from({ length: count }, () => close);
const dates = (entries: ReadonlyArray<{ date: string }>) => entries.map((entry) => entry.date);

describe('metals close screen v2 (D-G3-1)', () => {
  it('refuses a one-bar spike, admits the bars after it, and notes no level shift', () => {
    const bars = series('2030-01-07', ['2000', '2001', '2002', '2003', '2004', '2600', '2005', '2006', '2007', '2008']);
    const screen = metalsScreenClosesV2('XAU', bars, TODAY);
    expect(screen.refused).toEqual([{ date: bars[5].date, reason: 'outlier' }]);
    expect(dates(screen.admissible)).toEqual(dates(bars).filter((date) => date !== bars[5].date));
    expect(screen.levelShifts).toEqual([]);
  });

  it('heals a genuine 25% move within 3 bars and reports it with its dates', () => {
    const bars = series('2030-01-07', [...repeat('2000', 5), ...repeat('2500', 10)]);
    const screen = metalsScreenClosesV2('XAU', bars, TODAY);
    expect(screen.refused).toEqual(bars.slice(5, 8).map(({ date }) => ({ date, reason: 'outlier' })));
    expect(screen.admissible.at(-1)?.date).toBe(bars[14].date);
    expect(screen.levelShifts).toEqual([{ movedOn: bars[5].date, admittedOn: bars[8].date }]);
  });

  it('notes a move still refused (no close admitted after it yet)', () => {
    const bars = series('2030-01-07', [...repeat('2000', 5), '2500', '2500']);
    expect(metalsScreenClosesV2('XAU', bars, TODAY).levelShifts).toEqual([{ movedOn: bars[5].date, admittedOn: null }]);
  });

  it('refuses a ×31 unit error indefinitely: it never enters a median, and the last close goes stale', () => {
    const bars = series('2030-01-07', [...repeat('2000', 5), ...repeat('62000', 12)]);
    const screen = metalsScreenClosesV2('XAU', bars, TODAY);
    expect(screen.refused).toEqual(bars.slice(5).map(({ date }) => ({ date, reason: 'out-of-band' })));
    expect(dates(screen.admissible)).toEqual(dates(bars.slice(0, 5)));
    expect(screen.levelShifts).toEqual([]);
    const lastDay = bars.at(-1)!.date;
    const close = metalsCloseOnOrBefore(screen.admissible, lastDay)!;
    expect(close.date).toBe(bars[4].date);
    expect(metalsPriceStale(close.date, lastDay)).toBe(true);
    // A gram price read as an ounce price (÷ 31.1) is out of band too, for every metal's band.
    expect(metalsScreenClosesV2('XAU', series('2030-01-07', [...repeat('2000', 5), '64.3']), TODAY).refused)
      .toEqual([{ date: weekdays('2030-01-07', 6)[5], reason: 'out-of-band' }]);
    expect(Object.keys(METALS_PLAUSIBLE_CLOSES).sort()).toEqual(['XAG', 'XAU', 'XPD', 'XPT']);
  });

  it('mutant: without the bands the ×31 error would heal after 3 bars (so guard 1 is what keeps it out)', () => {
    const bars = series('2030-01-07', [...repeat('2000', 5), ...repeat('62000', 12)]);
    const screen = metalsScreenClosesWithGuards('XAU', bars, TODAY, { bands: false, levelShifts: true });
    expect(dates(screen.admissible)).toContain(bars[8].date);
    expect(screen.refused.some((entry) => entry.reason === 'out-of-band')).toBe(false);
  });

  it('mutant: without the note the 25% move would pass silently (so guard 2 is what reports it)', () => {
    const bars = series('2030-01-07', [...repeat('2000', 5), ...repeat('2500', 10)]);
    expect(metalsScreenClosesWithGuards('XAU', bars, TODAY, { bands: true, levelShifts: false }).levelShifts).toEqual([]);
  });

  it('keeps thin history, bar conflicts and today\'s bar as G1d reads them', () => {
    const [first, second, third] = weekdays('2030-01-07', 3);
    const screen = metalsScreenClosesV2('XAU', [
      { date: first, close: '2000' }, { date: second, close: '2010' }, { date: second, close: '2010.0' }, { date: third, close: '2020' },
      { date: third, close: '2021' }, { date: TODAY, close: '2030' },
    ], TODAY);
    expect(screen.admissible).toEqual([
      expect.objectContaining({ date: first, thinHistory: true }), expect.objectContaining({ date: second, thinHistory: true }),
    ]);
    expect(screen.refused).toEqual([{ date: third, reason: 'bar-conflict' }, { date: TODAY, reason: 'incomplete' }]);
  });

  it('reads a weekend or holiday as the last close before it, with that close\'s date', () => {
    const bars = series('2030-01-07', repeat('2000', 5));
    const screen = metalsScreenClosesV2('XAU', bars, TODAY);
    expect(metalsCloseOnOrBefore(screen.admissible, '2030-01-12')?.date).toBe('2030-01-11');
    expect(metalsCloseOnOrBefore(screen.admissible, '2030-01-06')).toBeNull();
  });
});
