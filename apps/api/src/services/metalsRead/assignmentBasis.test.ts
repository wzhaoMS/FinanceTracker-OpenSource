import { describe, expect, it } from 'vitest';

import {
  metalsAssignment,
  metalsLotUnitsAsOf,
  rational,
  type MetalsAssignment,
  type MetalsAssignmentSale,
  type MetalsEvent,
  type Rational,
} from '@finance-tracker/shared/metals-ledger';

// Synthetic ledgers only: invented lots, sales, days and cents from a seeded generator (no clock, no network).
//
// The Gold page's holdings as of t use the assignment as of t, and its activity the assignment as of today (approved).
// FIFO is causal: sales go in time order, each taking the earliest units ordered on or before its agreed day, so later
// lots and later sales never reach a sale up to t. Only a unit leaving after t (cancelled or returned) can: as of t it
// was kept or on the way, and a later leave never rewrites t, while today's assignment matches the sale again.

const BASE = '2030-01-01';
const TODAY = '2030-03-31';

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** mulberry32, so every run screens the same ledgers: a whole number below `below`. */
function generator(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * below);
  };
}

interface SyntheticLot {
  key: string;
  orderDate: string;
  quantity: number;
  fine: Rational;
  costMinor: number;
  events: MetalsEvent[];
}

const event = (kind: MetalsEvent['kind'], date: string): MetalsEvent => ({ kind, date, dateBasis: 'stated', quantity: 1, occurrence: 1 });
const FINES = [rational(1n), rational(1n, 2n)];

/** Up to 5 gold-bar lots in two classes (each unit delivered, maybe returned later, cancelled, or still on the way) and up to 4 sales. */
function syntheticLedger(next: (below: number) => number): { lots: SyntheticLot[]; sales: MetalsAssignmentSale[] } {
  const lots = Array.from({ length: 1 + next(5) }, (_, index): SyntheticLot => {
    const orderDate = addDays(BASE, next(60));
    const quantity = 1 + next(3);
    const events: MetalsEvent[] = [];
    for (let unit = 0; unit < quantity; unit += 1) {
      const roll = next(10);
      if (roll < 7) {
        const deliveredOn = addDays(orderDate, 1 + next(10));
        events.push(event('delivered', deliveredOn));
        if (next(5) === 0) events.push(event('returned', addDays(deliveredOn, 1 + next(20))));
      } else if (roll < 9) {
        events.push(event('cancelled', addDays(orderDate, 1 + next(10))));
      }
    }
    return { key: `lot-${index}`, orderDate, quantity, fine: FINES[next(2)], costMinor: 100_000 + next(200_000), events };
  });
  const sales = Array.from({ length: 1 + next(4) }, (_, index): MetalsAssignmentSale => {
    const agreedDay = addDays(BASE, next(90));
    return {
      key: `sale-${index}`, orderKey: `sale-order-${index}`, tradeMoment: `${agreedDay}T15:00:0${index}Z`, agreedDay, ordinal: 0, metal: 'XAU',
      form: 'bar', fineTroyOzPerUnit: FINES[next(2)], quantity: 1 + next(2), netMinor: 100_000 + next(200_000), cancelled: false,
    };
  });
  return { lots, sales };
}

/** The assignment as of a day, built as the views build it: each lot's units as of that day, later lots left out. */
function assignmentAsOf(lots: readonly SyntheticLot[], sales: readonly MetalsAssignmentSale[], asOf: string): MetalsAssignment {
  return metalsAssignment(lots.flatMap((lot) => {
    const units = metalsLotUnitsAsOf({ orderDate: lot.orderDate, quantity: lot.quantity, events: lot.events }, asOf);
    return units === null ? [] : [{
      key: lot.key, orderKey: `order-${lot.key}`, orderDate: lot.orderDate, ordinal: 0, metal: 'XAU' as const, form: 'bar' as const,
      fineTroyOzPerUnit: lot.fine, units, costMinor: lot.costMinor, costComplete: true,
    }];
  }), sales, asOf);
}

/** What an assignment says about the sales agreed up to t: their cycles, and how much of each was matched. */
function upTo(assignment: MetalsAssignment, sales: readonly MetalsAssignmentSale[], t: string) {
  const keys = new Set(sales.filter((sale) => sale.agreedDay <= t).map((sale) => sale.key));
  return {
    cycles: assignment.cycles.filter((cycle) => keys.has(cycle.saleKey)),
    sales: assignment.sales.filter((line) => keys.has(line.key))
      .map(({ key, matchedUnits, unmatchedUnits, matchedNetMinor, unmatchedNetMinor, known }) =>
        ({ key, matchedUnits, unmatchedUnits, matchedNetMinor, unmatchedNetMinor, known })),
  };
}

/** Whether a unit leaves the kept-or-on-the-way set after t (and by today). */
const leavesAfter = (lots: readonly SyntheticLot[], t: string) => lots.some((lot) => lot.events.some((entry) =>
  (entry.kind === 'cancelled' || entry.kind === 'returned') && entry.date !== null && entry.date > t && entry.date <= TODAY));

describe('the assignment basis: holdings as of t, activity as of today', () => {
  it('matches every sale up to t the same either way, unless a unit is cancelled or returned after t (seeded property)', () => {
    let compared = 0;
    let matched = 0;
    let leftOut = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const { lots, sales } = syntheticLedger(generator(seed));
      const today = assignmentAsOf(lots, sales, TODAY);
      for (let t = BASE; t <= TODAY; t = addDays(t, 3)) {
        if (leavesAfter(lots, t)) {
          leftOut += 1;
          continue;
        }
        const asOfT = upTo(assignmentAsOf(lots, sales, t), sales, t);
        expect(asOfT).toEqual(upTo(today, sales, t));
        compared += 1;
        if (asOfT.sales.some((line) => line.matchedUnits > 0)) matched += 1;
      }
    }
    // Not vacuous: many days compare matched sales, and some are left out for a later leave.
    expect(compared).toBeGreaterThan(1000);
    expect(matched).toBeGreaterThan(300);
    expect(leftOut).toBeGreaterThan(300);
  });

  it('matches a sale again today after a later cancellation, while t keeps its own reading', () => {
    const lot: SyntheticLot = { key: 'lot-1', orderDate: '2030-01-10', quantity: 1, fine: rational(1n), costMinor: 200_000,
      events: [event('cancelled', '2030-02-01')] };
    const sale: MetalsAssignmentSale = { key: 'sale-1', orderKey: 'sale-order-1', tradeMoment: '2030-01-20T15:00:00Z', agreedDay: '2030-01-20',
      ordinal: 0, metal: 'XAU', form: 'bar', fineTroyOzPerUnit: rational(1n), quantity: 1, netMinor: 210_000, cancelled: false };
    // As of 01-25 the bar was on its way, so the sale took it; today it is cancelled, and the sale has no purchase.
    expect(upTo(assignmentAsOf([lot], [sale], '2030-01-25'), [sale], '2030-01-25').sales)
      .toEqual([expect.objectContaining({ matchedUnits: 1, unmatchedUnits: 0 })]);
    const now = upTo(assignmentAsOf([lot], [sale], TODAY), [sale], '2030-01-25');
    expect(now.sales).toEqual([expect.objectContaining({ matchedUnits: 0, unmatchedUnits: 1 })]);
    expect(now.cycles).toEqual([]);
  });
});
