import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Metal, MetalForm, MetalsEvent } from '../model.js';
import { add, compare, formatRational, multiply, rational, readRational, ZERO, type Rational } from '../rational.js';
import {
  METALS_ASSIGNMENT_FUNGIBLE_RULE,
  metalsAssignment,
  metalsAssignmentClassForm,
  metalsClassForm,
  metalsProfitOnSales,
  type MetalsAssignment,
  type MetalsAssignmentLot,
  type MetalsAssignmentSale,
  type MetalsClassLedger,
} from './assignment.js';
import { metalsLotUnitsAsOf, type MetalsLotUnits } from './lifecycle.js';

/** Synthetic ledgers only: invented keys, dates, quantities and cents. */
const ONE_OZ = rational(1n);
const ASOF = '2030-06-30';
const units = (delivered: number, awaiting = 0, returned = 0, cancelled = 0): MetalsLotUnits => ({
  ordered: delivered + awaiting + returned + cancelled, cancelled, returned, delivered, awaiting, shippedAwaiting: false, dateUnknown: false,
  assignableDateUnknown: false,
});
const lot = (key: string, orderDate: string, lotUnits: MetalsLotUnits, costMinor: number, extra: Partial<MetalsAssignmentLot> = {}): MetalsAssignmentLot => ({
  key, orderKey: `order-${key}`, orderDate, ordinal: 0, metal: 'XAU', form: 'bar', fineTroyOzPerUnit: ONE_OZ, units: lotUnits, costMinor,
  costComplete: true, ...extra,
});
const sale = (key: string, agreedDay: string, quantity: number, netMinor: number, extra: Partial<MetalsAssignmentSale> = {}): MetalsAssignmentSale => ({
  key, orderKey: `sell-${key}`, tradeMoment: `${agreedDay}T15:00:00.000Z`, agreedDay, ordinal: 0, metal: 'XAU', form: 'bar',
  fineTroyOzPerUnit: ONE_OZ, quantity, netMinor, cancelled: false, ...extra,
});

function onlyClass(result: MetalsAssignment, metal: Metal = 'XAU'): MetalsClassLedger {
  const entry = result.metals.find((candidate) => candidate.metal === metal);
  assert.ok(entry, `a ledger for ${metal}`);
  assert.equal(entry.classes.length, 1);
  return entry.classes[0];
}

/** The per-class identities of §4.4.3. */
function identities(ledger: MetalsClassLedger, at = ledger.key): void {
  const { units: u, cents: c } = ledger;
  assert.equal(u.delivered + u.awaiting, u.held + (u.awaiting - u.soldFromAwaiting) + (u.sold - u.unmatched), `${at}: D + A = H + (A − S_A) + (S − U)`);
  assert.equal(u.sold, u.soldFromDelivered + u.soldFromAwaiting + u.unmatched, `${at}: S = S_D + S_A + U`);
  assert.equal(u.held, u.delivered - u.soldFromDelivered, `${at}: H = D − S_D`);
  assert.equal(u.awaitingUnassigned, u.awaiting - u.soldFromAwaiting, `${at}: awaiting not assigned = A − S_A`);
  assert.ok(u.held >= 0 && u.awaitingUnassigned >= 0, `${at}: nothing is assigned twice`);
  assert.equal(c.saleNets, c.cycleNets + c.unmatchedNets, `${at}: Σ sale nets = cycle nets + unmatched nets`);
  assert.equal(c.lotCosts, c.assignedCosts + c.heldCosts + c.awaitingUnassignedCosts + c.cancelledOrReturnedCosts,
    `${at}: Σ lot costs = assigned + held + awaiting unassigned + cancelled or returned`);
}

/** A seeded generator (mulberry32): deterministic, every bit in play, so small bounds vary too. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

describe('assignment: sales and the purchases assigned to them (GD-06)', () => {
  it('an entirely unmatched sale keeps its proceeds, with unknown basis and result', () => {
    const result = metalsAssignment([], [sale('s', '2030-03-01', 2, 500000)], ASOF);
    assert.deepEqual(result.cycles, []);
    assert.deepEqual(result.sales, [{
      key: 's', agreedDay: '2030-03-01', metal: 'XAU', contentKnown: true, units: 2, fineTroyOz: rational(2n), matchedUnits: 0,
      unmatchedUnits: 2, matchedNetMinor: 0, unmatchedNetMinor: 500000, known: false, costIncomplete: false, dateUnknownLots: [],
    }]);
    const ledger = onlyClass(result);
    assert.deepEqual(ledger.units, { delivered: 0, awaiting: 0, sold: 2, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 2, held: 0, awaitingUnassigned: 0 });
    assert.deepEqual(ledger.cents, {
      saleNets: 500000, cycleNets: 0, unmatchedNets: 500000, lotCosts: 0, assignedCosts: 0, heldCosts: 0, awaitingUnassignedCosts: 0,
      cancelledOrReturnedCosts: 0,
    });
    identities(ledger);
    const { profit, coverage } = metalsProfitOnSales(result, 'XAU', '2030-01-01', ASOF);
    assert.deepEqual(profit, { value: null, state: 'unknown', reasons: [{ code: 'unmatched-sales', records: 1 }] });
    assert.deepEqual(coverage, { basis: 'troy-oz', known: '0/1', total: '2/1', unknownContentLines: 0 });
  });

  it('a partly matched sale splits its cents exactly and is not a known sale line', () => {
    const result = metalsAssignment([lot('a', '2030-01-10', units(2), 400001)], [sale('s', '2030-03-01', 3, 700000)], ASOF);
    const [line] = result.sales;
    assert.deepEqual([line.matchedUnits, line.unmatchedUnits, line.matchedNetMinor, line.unmatchedNetMinor, line.known], [2, 1, 466667, 233333, false]);
    assert.equal(line.matchedNetMinor + line.unmatchedNetMinor, 700000);
    assert.deepEqual(result.cycles, [{
      lotKey: 'a', saleKey: 's', units: 2, fineTroyOz: rational(2n), costMinor: 400001, proceedsMinor: 466667, costComplete: true,
      profitMinor: 66666, orderDate: '2030-01-10', agreedDay: '2030-03-01', daysHeld: 50,
    }]);
    const ledger = onlyClass(result);
    assert.deepEqual(ledger.units, { delivered: 2, awaiting: 0, sold: 3, soldFromDelivered: 2, soldFromAwaiting: 0, unmatched: 1, held: 0, awaitingUnassigned: 0 });
    assert.deepEqual(ledger.cents, {
      saleNets: 700000, cycleNets: 466667, unmatchedNets: 233333, lotCosts: 400001, assignedCosts: 400001, heldCosts: 0,
      awaitingUnassignedCosts: 0, cancelledOrReturnedCosts: 0,
    });
    identities(ledger);
    const { profit, coverage } = metalsProfitOnSales(result, 'XAU', '2030-01-01', ASOF);
    assert.deepEqual(profit, { value: 66666, state: 'partial', reasons: [{ code: 'unmatched-sales', records: 1 }] });
    assert.deepEqual(coverage, { basis: 'troy-oz', known: '2/1', total: '3/1', unknownContentLines: 0 });
  });

  it('a sale while its purchase awaits delivery is sold from awaiting (S_A); a purchase ordered after the sale is never assigned to it', () => {
    const result = metalsAssignment(
      [lot('a', '2030-02-01', units(0, 1), 250000), lot('b', '2030-03-05', units(1), 260000)],
      [sale('s', '2030-03-01', 2, 520000)],
      ASOF,
    );
    const ledger = onlyClass(result);
    assert.deepEqual(ledger.units, { delivered: 1, awaiting: 1, sold: 2, soldFromDelivered: 0, soldFromAwaiting: 1, unmatched: 1, held: 1, awaitingUnassigned: 0 });
    assert.deepEqual(ledger.cents, {
      saleNets: 520000, cycleNets: 260000, unmatchedNets: 260000, lotCosts: 510000, assignedCosts: 250000, heldCosts: 260000,
      awaitingUnassignedCosts: 0, cancelledOrReturnedCosts: 0,
    });
    assert.deepEqual(result.cycles.map((cycle) => [cycle.lotKey, cycle.units]), [['a', 1]]);
    identities(ledger);
  });

  it('cancelled and returned units are never assigned, and a cancelled sale is left out at every date', () => {
    const result = metalsAssignment(
      [lot('a', '2030-01-10', units(1, 0, 1, 1), 300000)],
      [sale('s', '2030-02-01', 2, 220000), sale('x', '2030-02-02', 1, 110000, { cancelled: true })],
      ASOF,
    );
    assert.deepEqual(result.sales.map((line) => line.key), ['s']);
    const ledger = onlyClass(result);
    assert.deepEqual(ledger.units, { delivered: 1, awaiting: 0, sold: 2, soldFromDelivered: 1, soldFromAwaiting: 0, unmatched: 1, held: 0, awaitingUnassigned: 0 });
    assert.deepEqual(ledger.cents, {
      saleNets: 220000, cycleNets: 110000, unmatchedNets: 110000, lotCosts: 300000, assignedCosts: 100000, heldCosts: 0,
      awaitingUnassignedCosts: 0, cancelledOrReturnedCosts: 200000,
    });
    identities(ledger);
  });

  it('first in, first out within a class: order date, then order key, line ordinal and unit, delivered units first', () => {
    const lots = [
      lot('l1', '2030-01-10', units(1), 100, { orderKey: 'order-b', ordinal: 0 }),
      lot('l2', '2030-01-10', units(1), 200, { orderKey: 'order-a', ordinal: 1 }),
      lot('l3', '2030-01-10', units(1, 1), 301, { orderKey: 'order-a', ordinal: 0 }),
      lot('l4', '2030-01-05', units(0, 1), 400, { orderKey: 'order-z', ordinal: 0 }),
    ];
    const sales = [
      sale('late', '2030-02-01', 3, 3000, { tradeMoment: '2030-02-01T15:00:00.000Z' }),
      sale('early', '2030-02-01', 1, 1000, { tradeMoment: '2030-02-01T14:00:00.000Z' }),
    ];
    const result = metalsAssignment(lots, sales, ASOF);
    assert.deepEqual(result.cycles.map((cycle) => [cycle.saleKey, cycle.lotKey, cycle.units, cycle.costMinor]), [
      ['early', 'l4', 1, 400], ['late', 'l3', 2, 301], ['late', 'l2', 1, 200],
    ]);
    const ledger = onlyClass(result);
    assert.deepEqual(ledger.units, { delivered: 3, awaiting: 2, sold: 4, soldFromDelivered: 2, soldFromAwaiting: 2, unmatched: 0, held: 1, awaitingUnassigned: 0 });
    assert.equal(ledger.cents.heldCosts, 100);
    identities(ledger);
  });

  it('a lot\'s cost is split over its units by largest remainder, delivered units first', () => {
    const result = metalsAssignment([lot('a', '2030-01-10', units(1, 1, 0, 1), 1000)], [sale('s', '2030-02-01', 1, 500)], ASOF);
    const ledger = onlyClass(result);
    assert.deepEqual([result.cycles[0].costMinor, ledger.cents.awaitingUnassignedCosts, ledger.cents.cancelledOrReturnedCosts], [334, 333, 333]);
  });

  it('sales go in parsed trade-moment order, then order key and line ordinal, whatever their input order', () => {
    const moment = '2030-02-01T15:00:00.000Z';
    const lots = [lot('only', '2030-01-10', units(1), 1000)];
    const tie = [
      sale('b0', '2030-02-01', 1, 1100, { orderKey: 'sell-b', ordinal: 0, tradeMoment: moment }),
      sale('a1', '2030-02-01', 1, 1200, { orderKey: 'sell-a', ordinal: 1, tradeMoment: moment }),
      sale('a0', '2030-02-01', 1, 1300, { orderKey: 'sell-a', ordinal: 0, tradeMoment: moment }),
    ];
    assert.deepEqual(metalsAssignment(lots, tie, ASOF).cycles.map((cycle) => cycle.saleKey), ['a0']);
    assert.deepEqual(metalsAssignment(lots, [...tie].reverse(), ASOF).cycles.map((cycle) => cycle.saleKey), ['a0']);
    assert.deepEqual(metalsAssignment(lots, tie, ASOF).sales.map((line) => line.key), ['a0', 'a1', 'b0']);
    // "…15:00:00Z" is earlier than "…15:00:00.500Z" although it sorts after it as text.
    const whole = sale('whole', '2030-02-01', 1, 1400, { orderKey: 'sell-z', tradeMoment: '2030-02-01T15:00:00Z' });
    const fraction = sale('fraction', '2030-02-01', 1, 1500, { orderKey: 'sell-a', tradeMoment: '2030-02-01T15:00:00.500Z' });
    assert.deepEqual(metalsAssignment(lots, [fraction, whole], ASOF).cycles.map((cycle) => cycle.saleKey), ['whole']);
  });

  it('a class is (metal, form, fine troy oz per unit): an ingot is a bar; bullion or no form is "form not stated"', () => {
    assert.deepEqual((['bar', 'ingot', 'coin', 'round', 'bullion', null] as Array<MetalForm | null>).map(metalsClassForm),
      ['bar', 'bar', 'coin', 'round', 'unstated', 'unstated']);
    const result = metalsAssignment(
      [
        lot('ingot', '2030-01-10', units(1), 1000, { form: 'ingot' }),
        lot('bullion', '2030-01-10', units(1), 2000, { form: 'bullion' }),
        lot('silver', '2030-01-10', units(1), 3000, { metal: 'XAG' }),
      ],
      [
        sale('bar', '2030-02-01', 1, 1100),
        sale('none', '2030-02-01', 1, 2100, { form: null }),
        sale('half', '2030-02-01', 1, 600, { fineTroyOzPerUnit: rational(1n, 2n) }),
        sale('silver', '2030-02-01', 1, 3100, { metal: 'XAG' }),
      ],
      ASOF,
    );
    assert.deepEqual(result.cycles.map((cycle) => [cycle.saleKey, cycle.lotKey]), [['bar', 'ingot'], ['none', 'bullion'], ['silver', 'silver']]);
    assert.deepEqual(result.metals.map((entry) => [entry.metal, entry.classes.map((ledger) => ledger.key)]), [
      ['XAG', ['XAG|bar|1/1']],
      ['XAU', ['XAU|bar|1/1', 'XAU|bar|1/2', 'XAU|unstated|1/1']],
    ]);
    assert.equal(result.sales.find((line) => line.key === 'half')!.unmatchedUnits, 1);
  });

  it('content-unknown money is counted once, at its metal, outside every class', () => {
    const result = metalsAssignment(
      [
        lot('a', '2030-01-10', units(1), 200000),
        lot('held', '2030-01-11', units(1), 150000, { fineTroyOzPerUnit: null }),
        lot('several', '2030-01-12', units(1), 50000, { metal: null, fineTroyOzPerUnit: null }),
      ],
      [
        sale('s', '2030-02-01', 1, 210000),
        sale('unknown', '2030-02-02', 1, 160000, { fineTroyOzPerUnit: null }),
        sale('mixed', '2030-02-03', 1, 40000, { metal: null, fineTroyOzPerUnit: null }),
      ],
      ASOF,
    );
    assert.equal(result.metals.length, 1);
    const [gold] = result.metals;
    assert.deepEqual(gold.contentUnknown, { lots: ['held'], sales: ['unknown'], lotCostMinor: 150000, saleNetMinor: 160000 });
    assert.deepEqual(result.metalUnknown, { lots: ['several'], sales: ['mixed'], lotCostMinor: 50000, saleNetMinor: 40000 });
    const [ledger] = gold.classes;
    assert.equal(gold.classes.length, 1);
    assert.deepEqual([ledger.units.delivered, ledger.units.sold, ledger.cents.lotCosts, ledger.cents.saleNets], [1, 1, 200000, 210000]);
    assert.equal(210000 + 160000, ledger.cents.cycleNets + ledger.cents.unmatchedNets + gold.contentUnknown.saleNetMinor);
    assert.equal(200000 + 150000, ledger.cents.lotCosts + gold.contentUnknown.lotCostMinor);
    const unknownLine = result.sales.find((line) => line.key === 'unknown')!;
    assert.deepEqual([unknownLine.contentKnown, unknownLine.fineTroyOz, unknownLine.known, unknownLine.unmatchedUnits], [false, null, false, 0]);
    identities(ledger);
  });
});

describe('assignment: profit or loss on sales, with its coverage', () => {
  const lots = [lot('a', '2030-01-10', units(1), 200000)];

  it('is complete, in troy ounces, when every sale line is known', () => {
    const result = metalsAssignment(lots, [sale('s', '2030-02-01', 1, 230000)], ASOF);
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-01-01', ASOF), {
      profit: { value: 30000, state: 'complete', reasons: [] },
      coverage: { basis: 'troy-oz', known: '1/1', total: '1/1', unknownContentLines: 0 },
    });
  });

  it('counts troy ounces while every sale line has known content', () => {
    const result = metalsAssignment(lots, [sale('s', '2030-02-01', 1, 230000), sale('t', '2030-02-02', 1, 240000)], ASOF);
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-01-01', ASOF), {
      profit: { value: 30000, state: 'partial', reasons: [{ code: 'unmatched-sales', records: 1 }] },
      coverage: { basis: 'troy-oz', known: '1/1', total: '2/1', unknownContentLines: 0 },
    });
  });

  it('counts sale lines once any line has unknown content: one fully costed sale plus one content-unknown sale', () => {
    const result = metalsAssignment(lots, [sale('s', '2030-02-01', 1, 230000), sale('u', '2030-02-02', 1, 150000, { fineTroyOzPerUnit: null })], ASOF);
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-01-01', ASOF), {
      profit: { value: 30000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }] },
      coverage: { basis: 'sale-lines', known: '1', total: '2', unknownContentLines: 1 },
    });
  });

  it('in troy ounces, a partly matched line\'s costed cycles count, as their ounces do', () => {
    const result = metalsAssignment(lots, [sale('p', '2030-02-01', 2, 460000)], ASOF);
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-01-01', ASOF), {
      profit: { value: 30000, state: 'partial', reasons: [{ code: 'unmatched-sales', records: 1 }] },
      coverage: { basis: 'troy-oz', known: '1/1', total: '2/1', unknownContentLines: 0 },
    });
  });

  it('in sale lines, only known lines count: a partly matched line adds nothing, and with none known the result is unknown', () => {
    const none = metalsAssignment(lots, [sale('p', '2030-02-01', 2, 460000), sale('u', '2030-02-02', 1, 150000, { fineTroyOzPerUnit: null })], ASOF);
    assert.equal(none.cycles[0].profitMinor, 30000);
    assert.deepEqual(metalsProfitOnSales(none, 'XAU', '2030-01-01', ASOF), {
      profit: { value: null, state: 'unknown', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'unmatched-sales', records: 1 }] },
      coverage: { basis: 'sale-lines', known: '0', total: '2', unknownContentLines: 1 },
    });
    const some = metalsAssignment(
      [...lots, lot('b', '2030-01-11', units(1), 300000)],
      [sale('k', '2030-02-01', 1, 250000), sale('p', '2030-02-02', 2, 640000), sale('u', '2030-02-03', 1, 100000, { fineTroyOzPerUnit: null })],
      ASOF,
    );
    assert.deepEqual(some.cycles.map((cycle) => [cycle.saleKey, cycle.lotKey, cycle.profitMinor]), [['k', 'a', 50000], ['p', 'b', 20000]]);
    assert.deepEqual(metalsProfitOnSales(some, 'XAU', '2030-01-01', ASOF), {
      profit: { value: 50000, state: 'partial', reasons: [{ code: 'content-unknown', records: 1 }, { code: 'unmatched-sales', records: 1 }] },
      coverage: { basis: 'sale-lines', known: '1', total: '3', unknownContentLines: 1 },
    });
  });

  it('an incomplete cost leaves the result unknown, never zero; a loss is negative', () => {
    const incomplete = metalsAssignment([lot('a', '2030-01-10', units(1), 200000, { costComplete: false })], [sale('s', '2030-02-01', 1, 230000)], ASOF);
    assert.deepEqual(incomplete.cycles[0].profitMinor, null);
    assert.deepEqual(incomplete.sales[0].costIncomplete, true);
    assert.deepEqual(metalsProfitOnSales(incomplete, 'XAU', '2030-01-01', ASOF), {
      profit: { value: null, state: 'unknown', reasons: [{ code: 'cost-unattributed', records: 1 }] },
      coverage: { basis: 'troy-oz', known: '0/1', total: '1/1', unknownContentLines: 0 },
    });
    const loss = metalsAssignment(lots, [sale('s', '2030-02-01', 1, 190000)], ASOF);
    assert.deepEqual(metalsProfitOnSales(loss, 'XAU', '2030-01-01', ASOF).profit, { value: -10000, state: 'complete', reasons: [] });
  });

  it('reads one metal over one period: other metals and sales outside the period are left out', () => {
    const result = metalsAssignment(
      [...lots, lot('g', '2030-01-10', units(1), 3000, { metal: 'XAG' })],
      [sale('s', '2030-02-01', 1, 230000), sale('later', '2030-03-15', 1, 250000), sale('silver', '2030-02-01', 1, 3500, { metal: 'XAG' })],
      ASOF,
    );
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-02-01', '2030-02-28'), {
      profit: { value: 30000, state: 'complete', reasons: [] },
      coverage: { basis: 'troy-oz', known: '1/1', total: '1/1', unknownContentLines: 0 },
    });
    assert.deepEqual(metalsProfitOnSales(result, 'XAG', '2030-02-01', '2030-02-28').profit, { value: 500, state: 'complete', reasons: [] });
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-04-01', '2030-04-30'), {
      profit: { value: 0, state: 'complete', reasons: [] },
      coverage: { basis: 'troy-oz', known: '0/1', total: '0/1', unknownContentLines: 0 },
    });
  });
});

describe('assignment: as of a date', () => {
  const delivered: MetalsEvent = { kind: 'delivered', date: '2030-01-10', dateBasis: 'stated', quantity: 2, occurrence: 1 };
  const returned: MetalsEvent = { kind: 'returned', date: '2030-02-15', dateBasis: 'stated', quantity: 1, occurrence: 1 };
  function asOf(events: MetalsEvent[], date: string, sales = [sale('s', '2030-01-20', 1, 210000)]): MetalsAssignment {
    const lotUnits = metalsLotUnitsAsOf({ orderDate: '2030-01-05', quantity: 2, events }, date);
    assert.ok(lotUnits);
    return metalsAssignment([lot('a', '2030-01-05', lotUnits, 400000)], sales, date);
  }

  it('a return dated after a month leaves that month unchanged', () => {
    const january = asOf([delivered, returned], '2030-01-31');
    assert.deepEqual(january, asOf([delivered], '2030-01-31'));
    assert.deepEqual(onlyClass(january).units, { delivered: 2, awaiting: 0, sold: 1, soldFromDelivered: 1, soldFromAwaiting: 0, unmatched: 0, held: 1, awaitingUnassigned: 0 });
    const february = asOf([delivered, returned], '2030-02-28');
    assert.deepEqual(onlyClass(february).units, { delivered: 1, awaiting: 0, sold: 1, soldFromDelivered: 1, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0 });
    assert.equal(onlyClass(february).cents.cancelledOrReturnedCosts, 200000);
    identities(onlyClass(january));
    identities(onlyClass(february));
  });

  it('a sale agreed after the date is not in its figures yet', () => {
    const result = asOf([delivered], '2030-01-31', [sale('later', '2030-02-01', 1, 210000)]);
    assert.deepEqual(result.sales, []);
    assert.equal(onlyClass(result).units.held, 2);
  });
});

describe('assignment: date-uncertain cancellations and returns (§4.3)', () => {
  const happened = (kind: MetalsEvent['kind'], date: string | null, dateBasis: MetalsEvent['dateBasis'] = date === null ? null : 'stated'): MetalsEvent =>
    ({ kind, date, dateBasis, quantity: 1, occurrence: 1 });
  const DELIVERED = happened('delivered', '2030-01-06');
  /** Real lifecycle output, then assignment, then profit: lot A (Jan 5) and lot B (Jan 10) of one class, a sale on Jan 20. */
  function compose(lotAEvents: MetalsEvent[], asOfDate = '2030-01-31') {
    const lifecycle = (orderDate: string, events: MetalsEvent[]) => {
      const lotUnits = metalsLotUnitsAsOf({ orderDate, quantity: 1, events }, asOfDate);
      assert.ok(lotUnits);
      return lotUnits;
    };
    const result = metalsAssignment(
      [
        lot('lot-a', '2030-01-05', lifecycle('2030-01-05', lotAEvents), 10000),
        lot('lot-b', '2030-01-10', lifecycle('2030-01-10', [happened('delivered', '2030-01-11')]), 20000),
      ],
      [sale('sale-a', '2030-01-20', 1, 25000)],
      asOfDate,
    );
    return { result, profit: metalsProfitOnSales(result, 'XAU', '2030-01-01', asOfDate) };
  }
  const uncertain = (value: number) => ({ value, state: 'partial', reasons: [{ code: 'date-unknown', records: 1 }] });
  const ONE_OF_ONE = { basis: 'troy-oz', known: '1/1', total: '1/1', unknownContentLines: 0 };

  it('an undated return on an earlier lot the sale skipped leaves its purchase uncertain: partial, date-unknown', () => {
    const { result, profit } = compose([DELIVERED, happened('returned', null)]);
    assert.deepEqual(result.cycles.map((cycle) => [cycle.lotKey, cycle.profitMinor]), [['lot-b', 5000]]);
    assert.deepEqual(result.sales[0].dateUnknownLots, ['lot-a']);
    assert.deepEqual(onlyClass(result).dateUnknownLots, ['lot-a']);
    assert.deepEqual(profit, { profit: uncertain(5000), coverage: ONE_OF_ONE });
  });

  it('a year-inferred return does the same, on either side of the date', () => {
    const counted = compose([DELIVERED, happened('returned', '2030-01-15', 'year-inferred')]);
    assert.deepEqual(counted.result.cycles.map((cycle) => cycle.lotKey), ['lot-b']);
    assert.deepEqual(counted.profit, { profit: uncertain(5000), coverage: ONE_OF_ONE });
    const notYet = compose([DELIVERED, happened('returned', '2030-02-15', 'year-inferred')]);
    assert.deepEqual(notYet.result.cycles.map((cycle) => cycle.lotKey), ['lot-a']);
    assert.deepEqual(notYet.result.sales[0].dateUnknownLots, ['lot-a']);
    assert.deepEqual(notYet.profit, { profit: uncertain(15000), coverage: ONE_OF_ONE });
  });

  it('a stated return before the date is complete; a stated later return leaves the earlier period unchanged', () => {
    const before = compose([DELIVERED, happened('returned', '2030-01-15')]);
    assert.deepEqual(before.result.cycles.map((cycle) => cycle.lotKey), ['lot-b']);
    assert.deepEqual([before.result.sales[0].dateUnknownLots, onlyClass(before.result).dateUnknownLots], [[], []]);
    assert.deepEqual(before.profit, { profit: { value: 5000, state: 'complete', reasons: [] }, coverage: ONE_OF_ONE });
    const later = compose([DELIVERED, happened('returned', '2030-02-15')]);
    assert.deepEqual(later.result, compose([DELIVERED]).result);
    assert.deepEqual(later.profit, { profit: { value: 15000, state: 'complete', reasons: [] }, coverage: ONE_OF_ONE });
  });

  it('an uncertain delivery date leaves every sale\'s purchases certain, but marks its class\'s holdings', () => {
    const { result, profit } = compose([happened('delivered', null)]);
    assert.deepEqual(result.cycles.map((cycle) => cycle.lotKey), ['lot-a']);
    assert.deepEqual([result.sales[0].dateUnknownLots, onlyClass(result).dateUnknownLots], [[], ['lot-a']]);
    assert.deepEqual(profit.profit, { value: 15000, state: 'complete', reasons: [] });
  });

  it('marks only the sales whose purchases could change, once per sale line, in their own class and period', () => {
    const uncertainReturn: MetalsLotUnits = { ...units(0, 0, 1), dateUnknown: true, assignableDateUnknown: true };
    const uncertainCancel: MetalsLotUnits = { ...units(0, 0, 0, 1), dateUnknown: true, assignableDateUnknown: true };
    const result = metalsAssignment(
      [
        lot('lot-k', '2030-01-01', units(2), 20000),
        lot('lot-a', '2030-01-05', uncertainReturn, 10000),
        lot('lot-c', '2030-01-06', uncertainCancel, 10000),
        lot('lot-b', '2030-01-10', units(1), 20000),
        lot('lot-s', '2030-01-02', uncertainReturn, 300, { metal: 'XAG' }),
        lot('lot-t', '2030-01-03', units(1), 300, { metal: 'XAG' }),
      ],
      [
        sale('early', '2030-01-03', 1, 21000),
        sale('served', '2030-01-20', 1, 22000),
        sale('later', '2030-01-25', 1, 23000),
        sale('unmatched', '2030-01-26', 1, 24000),
        sale('silver', '2030-01-20', 1, 400, { metal: 'XAG' }),
      ],
      ASOF,
    );
    const marks = Object.fromEntries(result.sales.map((line) => [line.key, line.dateUnknownLots]));
    assert.deepEqual(marks, { early: [], served: [], silver: ['lot-s'], later: ['lot-a', 'lot-c'], unmatched: ['lot-a', 'lot-c'] });
    assert.deepEqual(result.metals.map((entry) => [entry.metal, entry.classes.map((ledger) => ledger.dateUnknownLots)]), [
      ['XAG', [['lot-s']]], ['XAU', [['lot-a', 'lot-c']]],
    ]);
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-01-01', '2030-01-31'), {
      profit: { value: 26000, state: 'partial', reasons: [{ code: 'unmatched-sales', records: 1 }, { code: 'date-unknown', records: 2 }] },
      coverage: { basis: 'troy-oz', known: '3/1', total: '4/1', unknownContentLines: 0 },
    });
    assert.deepEqual(metalsProfitOnSales(result, 'XAU', '2030-01-01', '2030-01-22').profit, { value: 23000, state: 'complete', reasons: [] });
    assert.deepEqual(metalsProfitOnSales(result, 'XAG', '2030-01-01', '2030-01-31').profit, uncertain(100));
  });

  it('leaves a sale line unmarked only when its purchases stay the same whichever way the undated facts fall (seeded)', () => {
    const next = seeded(4242);
    const day = (offset: number) => new Date(Date.UTC(2030, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    const two = (value: number) => String(value).padStart(2, '0');
    const asOfDate = day(70);
    const seen = { marked: 0, markedChanged: 0, unmarkedBesideUncertainty: 0 };
    for (let round = 0; round < 300; round += 1) {
      // One class. A lot may carry an undated cancellation or return, which the lifecycle counts as happened.
      const generated = Array.from({ length: 2 + next(6) }, (_, index) => {
        const order = next(50);
        const quantity = 1 + next(3);
        const stated = (kind: MetalsEvent['kind'], count: number): MetalsEvent =>
          ({ kind, date: day(order + next(5)), dateBasis: 'stated', quantity: count, occurrence: 1 });
        const undated = (kind: MetalsEvent['kind'], count: number): MetalsEvent => ({ kind, date: null, dateBasis: null, quantity: count, occurrence: 1 });
        const fate = next(4);
        const events: MetalsEvent[] = [];
        if (fate === 0) {
          const cancelled = 1 + next(quantity);
          events.push(undated('cancelled', cancelled));
          if (cancelled < quantity) events.push(stated('delivered', quantity - cancelled));
        } else {
          events.push(stated('delivered', quantity));
          if (fate === 1) events.push(undated('returned', 1 + next(quantity)));
        }
        return { key: `lot-${round}-${index}`, orderDate: day(order), quantity, events, costMinor: 1000 * (1 + next(9)) };
      });
      const sales = Array.from({ length: 1 + next(6) }, (_, index) => {
        const agreed = day(next(70));
        return sale(`sale-${round}-${index}`, agreed, 1 + next(2), 1000 * (1 + next(30)), {
          orderKey: `sell-${round}`, ordinal: index, tradeMoment: `${agreed}T${two(13 + next(10))}:${two(next(60))}:00.000Z`,
        });
      });
      // The recorded view, and the view where every undated cancellation and return falls after the date.
      const run = (undatedLater: boolean) => metalsAssignment(generated.map((entry) => {
        const events = undatedLater ? entry.events.filter((event) => event.date !== null) : entry.events;
        const lotUnits = metalsLotUnitsAsOf({ orderDate: entry.orderDate, quantity: entry.quantity, events }, asOfDate);
        assert.ok(lotUnits);
        return lot(entry.key, entry.orderDate, lotUnits, entry.costMinor);
      }), sales, asOfDate);
      const recorded = run(false);
      const alternative = run(true);
      const purchases = (result: MetalsAssignment, saleKey: string) => JSON.stringify({
        unmatched: result.sales.find((line) => line.key === saleKey)!.unmatchedUnits,
        cycles: result.cycles.filter((cycle) => cycle.saleKey === saleKey)
          .map((cycle) => [cycle.lotKey, cycle.units, cycle.costMinor, cycle.proceedsMinor].join('|')).sort(),
      });
      const uncertainLots = generated.filter((entry) => entry.events.some((event) => event.date === null));
      for (const line of recorded.sales) {
        const same = purchases(recorded, line.key) === purchases(alternative, line.key);
        if (line.dateUnknownLots.length === 0) {
          assert.ok(same, `round ${round}: ${line.key} is unmarked but its purchases change`);
          if (uncertainLots.some((entry) => entry.orderDate <= line.agreedDay)) seen.unmarkedBesideUncertainty += 1;
          continue;
        }
        seen.marked += 1;
        if (!same) seen.markedChanged += 1;
        for (const key of line.dateUnknownLots) {
          assert.ok(uncertainLots.some((entry) => entry.key === key && entry.orderDate <= line.agreedDay), `round ${round}: ${key}`);
        }
      }
    }
    for (const [name, count] of Object.entries(seen)) assert.ok(count > 0, `the generated ledgers exercise ${name}`);
  });
});

describe('assignment: identities on generated ledgers (property)', () => {
  it('conserves units and cents per class and per metal, and assigns only what it may (seeded)', () => {
    const next = seeded(20301);
    const day = (offset: number) => new Date(Date.UTC(2030, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    const two = (value: number) => String(value).padStart(2, '0');
    const metalChoices: Array<Metal | null> = ['XAU', 'XAU', 'XAG', null];
    const forms: Array<MetalForm | null> = ['bar', 'ingot', 'coin', 'round', 'bullion', null];
    const fines = [rational(1n), rational(1n, 2n), rational(1n, 10n), rational(5n)];
    const classKey = (metal: Metal, form: MetalForm | null, fine: Rational) => `${metal}|${metalsClassForm(form)}|${formatRational(fine)}`;
    const totals = { cycles: 0, unmatched: 0, fromAwaiting: 0, held: 0, contentUnknown: 0, cancelledOrReturned: 0 };

    for (let round = 0; round < 300; round += 1) {
      const pick = () => {
        const metal = metalChoices[next(metalChoices.length)];
        return { metal, form: forms[next(forms.length)], fineTroyOzPerUnit: metal === null || next(6) === 0 ? null : fines[next(fines.length)] };
      };
      // Buys: an order date per order key; each unit's own story (awaiting, cancelled, delivered, delivered then returned).
      const orderDates = [next(120), next(120), next(120)];
      const generated: Array<{ base: MetalsAssignmentLot; quantity: number; events: MetalsEvent[] }> = [];
      for (let index = 0, count = next(9); index < count; index += 1) {
        const order = orderDates[index % 3];
        const quantity = 1 + next(5);
        const grouped = new Map<string, number>();
        const note = (kind: MetalsEvent['kind'], offset: number) => grouped.set(`${kind}|${offset}`, (grouped.get(`${kind}|${offset}`) ?? 0) + 1);
        for (let unit = 0; unit < quantity; unit += 1) {
          const fate = next(4);
          if (fate === 1) note('cancelled', order + next(30));
          if (fate >= 2) {
            const deliveredAt = order + next(30);
            note('delivered', deliveredAt);
            if (fate === 3) note('returned', deliveredAt + 1 + next(40));
          }
        }
        const events = [...grouped].map(([key, count]): MetalsEvent => {
          const [kind, offset] = key.split('|');
          return { kind: kind as MetalsEvent['kind'], date: day(Number(offset)), dateBasis: 'stated', quantity: count, occurrence: 1 };
        });
        const base = lot(`lot-${round}-${index}`, day(order), units(0), next(3) === 0 ? next(5000) : next(900000), {
          ...pick(), orderKey: `order-${round}-${index % 3}`, ordinal: Math.floor(index / 3), costComplete: next(5) !== 0,
        });
        generated.push({ base, quantity, events });
      }
      // Sales: trade moments inside New York's business day, so the agreed day is the moment's own date.
      const sales: MetalsAssignmentSale[] = [];
      for (let index = 0, count = next(9); index < count; index += 1) {
        const agreed = day(next(160));
        sales.push(sale(`sale-${round}-${index}`, agreed, 1 + next(4), next(600000), {
          ...pick(), orderKey: `sell-${round}-${index % 2}`, ordinal: Math.floor(index / 2),
          tradeMoment: `${agreed}T${two(13 + next(10))}:${two(next(60))}:00.000Z`, cancelled: next(10) === 0,
        }));
      }

      for (const asOfDate of [day(next(200)), day(90), day(200)]) {
        const lots: MetalsAssignmentLot[] = [];
        for (const entry of generated) {
          const lotUnits = metalsLotUnitsAsOf({ orderDate: entry.base.orderDate, quantity: entry.quantity, events: entry.events }, asOfDate);
          if (lotUnits !== null) lots.push({ ...entry.base, units: lotUnits });
        }
        const result = metalsAssignment(lots, sales, asOfDate);
        const at = `round ${round} as of ${asOfDate}`;
        const included = sales.filter((entry) => !entry.cancelled && entry.agreedDay <= asOfDate);
        const lotByKey = new Map(lots.map((entry) => [entry.key, entry]));
        const saleByKey = new Map(included.map((entry) => [entry.key, entry]));
        const classed = (item: { metal: Metal | null; form: MetalForm | null; fineTroyOzPerUnit: Rational | null }) =>
          (item.metal === null || item.fineTroyOzPerUnit === null ? null : classKey(item.metal, item.form, item.fineTroyOzPerUnit));
        const assignedOf = (lotKey: string) => result.cycles.filter((cycle) => cycle.lotKey === lotKey).reduce((total, cycle) => total + cycle.units, 0);

        assert.deepEqual(result.sales.map((line) => line.key).sort(), included.map((entry) => entry.key).sort(), `${at}: one line per sale in the figure`);

        // Per class: the identities, and the cycles agree with the class's cents and units.
        for (const entry of result.metals) {
          let classNets = 0;
          let classCosts = 0;
          for (const ledger of entry.classes) {
            identities(ledger, `${at} ${ledger.key}`);
            const cycles = result.cycles.filter((cycle) => classed(lotByKey.get(cycle.lotKey)!) === ledger.key);
            assert.equal(cycles.reduce((total, cycle) => total + cycle.proceedsMinor, 0), ledger.cents.cycleNets, `${at}: cycle proceeds`);
            assert.equal(cycles.reduce((total, cycle) => total + cycle.costMinor, 0), ledger.cents.assignedCosts, `${at}: cycle costs`);
            assert.equal(cycles.reduce((total, cycle) => total + cycle.units, 0), ledger.units.sold - ledger.units.unmatched, `${at}: cycle units`);
            classNets += ledger.cents.cycleNets + ledger.cents.unmatchedNets;
            classCosts += ledger.cents.lotCosts;
            totals.unmatched += ledger.units.unmatched;
            totals.fromAwaiting += ledger.units.soldFromAwaiting;
            totals.held += ledger.units.held;
            totals.cancelledOrReturned += ledger.cents.cancelledOrReturnedCosts > 0 ? 1 : 0;
          }
          // Per metal: Σ sale nets = cycle nets + unmatched nets + content-unknown nets; the same for lot costs.
          const metalSales = included.filter((item) => item.metal === entry.metal);
          const metalLots = lots.filter((item) => item.metal === entry.metal);
          assert.equal(metalSales.reduce((total, item) => total + item.netMinor, 0), classNets + entry.contentUnknown.saleNetMinor, `${at}: ${entry.metal} nets`);
          assert.equal(metalLots.reduce((total, item) => total + item.costMinor, 0), classCosts + entry.contentUnknown.lotCostMinor, `${at}: ${entry.metal} costs`);
          totals.contentUnknown += entry.contentUnknown.lots.length + entry.contentUnknown.sales.length;
        }
        for (const metal of ['XAU', 'XAG'] as const) {
          if (result.metals.some((entry) => entry.metal === metal)) continue;
          assert.ok(!included.some((item) => item.metal === metal) && !lots.some((item) => item.metal === metal), `${at}: no ${metal} left out`);
        }
        assert.equal(included.filter((item) => item.metal === null).reduce((total, item) => total + item.netMinor, 0), result.metalUnknown.saleNetMinor);
        assert.equal(lots.filter((item) => item.metal === null).reduce((total, item) => total + item.costMinor, 0), result.metalUnknown.lotCostMinor);

        // Each cycle: a purchase of the sale's class, ordered on or before its agreed day, with a result only at full cost.
        for (const cycle of result.cycles) {
          const lotEntry = lotByKey.get(cycle.lotKey)!;
          const saleEntry = saleByKey.get(cycle.saleKey)!;
          assert.ok(lotEntry.orderDate <= saleEntry.agreedDay, `${at}: never a purchase ordered after the sale`);
          assert.equal(classed(lotEntry), classed(saleEntry), `${at}: the same class`);
          assert.equal(cycle.costComplete, lotEntry.costComplete);
          assert.equal(cycle.profitMinor, cycle.costComplete ? cycle.proceedsMinor - cycle.costMinor : null);
          assert.ok(compare(cycle.fineTroyOz, multiply(saleEntry.fineTroyOzPerUnit!, rational(BigInt(cycle.units)))) === 0);
          totals.cycles += 1;
        }
        // Each lot: never more units assigned than it has delivered or awaiting.
        for (const lotEntry of lots) {
          if (classed(lotEntry) === null) assert.equal(assignedOf(lotEntry.key), 0);
          else assert.ok(assignedOf(lotEntry.key) <= lotEntry.units.delivered + lotEntry.units.awaiting, `${at}: ${lotEntry.key} over-assigned`);
        }
        // Each sale line: its units and cents split exactly; known only when every unit is matched at full cost; a unit is
        // left unmatched only when every eligible purchase of its class is used up.
        for (const line of result.sales) {
          const saleEntry = saleByKey.get(line.key)!;
          const cycles = result.cycles.filter((cycle) => cycle.saleKey === line.key);
          if (!line.contentKnown) {
            assert.deepEqual([line.matchedUnits, line.unmatchedUnits, cycles.length, line.known], [0, 0, 0, false]);
            continue;
          }
          assert.equal(line.matchedUnits + line.unmatchedUnits, saleEntry.quantity);
          assert.equal(line.matchedNetMinor + line.unmatchedNetMinor, saleEntry.netMinor);
          assert.equal(cycles.reduce((total, cycle) => total + cycle.units, 0), line.matchedUnits);
          assert.equal(cycles.reduce((total, cycle) => total + cycle.proceedsMinor, 0), line.matchedNetMinor);
          assert.equal(line.known, line.unmatchedUnits === 0 && cycles.every((cycle) => cycle.costComplete));
          if (line.unmatchedUnits === 0) continue;
          for (const lotEntry of lots) {
            if (classed(lotEntry) !== classed(saleEntry) || lotEntry.orderDate > saleEntry.agreedDay) continue;
            assert.equal(assignedOf(lotEntry.key), lotEntry.units.delivered + lotEntry.units.awaiting, `${at}: ${line.key} unmatched beside ${lotEntry.key}`);
          }
        }
        // Coverage: troy ounces only while every line in the period has known content; unknown-content lines always count.
        for (const metal of ['XAU', 'XAG'] as const) {
          const from = day(next(100));
          const to = day(100 + next(100));
          const { profit, coverage } = metalsProfitOnSales(result, metal, from, to);
          const lines = result.sales.filter((line) => line.metal === metal && line.agreedDay >= from && line.agreedDay <= to);
          const unknownContent = lines.filter((line) => !line.contentKnown).length;
          assert.equal(coverage.unknownContentLines, unknownContent);
          if (unknownContent > 0) {
            assert.deepEqual([coverage.basis, coverage.known, coverage.total], ['sale-lines', String(lines.filter((line) => line.known).length), String(lines.length)]);
          } else {
            assert.equal(coverage.basis, 'troy-oz');
            const total = lines.reduce((sum, line) => add(sum, line.fineTroyOz!), ZERO);
            assert.ok(compare(readRational(coverage.known)!, readRational(coverage.total)!) <= 0 && compare(readRational(coverage.total)!, total) === 0);
          }
          const keys = new Set(lines.map((line) => line.key));
          const knownKeys = new Set(lines.filter((line) => line.known).map((line) => line.key));
          const counted = result.cycles.filter((cycle) => keys.has(cycle.saleKey) && cycle.costComplete
            && (unknownContent === 0 || knownKeys.has(cycle.saleKey)));
          if (lines.length === 0) {
            assert.deepEqual(profit, { value: 0, state: 'complete', reasons: [] });
            continue;
          }
          if (counted.length === 0) assert.deepEqual([profit.value, profit.state], [null, 'unknown']);
          else assert.equal(profit.value, counted.reduce((sum, cycle) => sum + cycle.profitMinor!, 0));
          // The value and the coverage describe the same set: nothing known exactly when there is no value.
          assert.equal(profit.value === null, coverage.known === (coverage.basis === 'troy-oz' ? '0/1' : '0'), `${at}: ${metal} coverage`);
        }
      }
    }
    for (const [name, count] of Object.entries(totals)) assert.ok(count > 0, `the generated ledgers exercise ${name}`);
  });
});

describe('assignment: the owner\'s fungible policy (HOLDR_METALS_FUNGIBLE, metals-assignment-v1+fungible)', () => {
  const FORMS: Array<MetalForm | null> = ['bar', 'ingot', 'coin', 'round', 'bullion', null];

  it('classes an item of a metal the policy names as `any`, and every other item by its form, as v1 does', () => {
    assert.equal(METALS_ASSIGNMENT_FUNGIBLE_RULE, 'metals-assignment-v1+fungible');
    for (const form of FORMS) {
      assert.equal(metalsAssignmentClassForm('XAU', form), metalsClassForm(form), String(form));
      assert.equal(metalsAssignmentClassForm('XAU', form, { fungible: [] }), metalsClassForm(form), String(form));
      assert.equal(metalsAssignmentClassForm('XAU', form, { fungible: ['XAG', 'XPT'] }), metalsClassForm(form), String(form));
      assert.equal(metalsAssignmentClassForm('XAU', form, { fungible: ['XAU'] }), 'any', String(form));
      assert.equal(metalsAssignmentClassForm('XAG', form, { fungible: ['XAU', 'XAG'] }), 'any', String(form));
    }
  });

  it('reads metals-assignment-v1 exactly with no policy, an empty one, or one naming other metals (seeded)', () => {
    const next = seeded(4242);
    const day = (offset: number) => new Date(Date.UTC(2030, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    const fines = [ONE_OZ, rational(1n, 2n)];
    // Bars two times in three, so v1's own classes match often; every form still comes up.
    const item = () => ({ metal: (next(3) === 0 ? 'XAG' : 'XAU') as Metal, form: next(3) === 0 ? FORMS[next(FORMS.length)] : 'bar' as const,
      fineTroyOzPerUnit: next(8) === 0 ? null : fines[next(fines.length)] });
    let cycles = 0;
    for (let round = 0; round < 200; round += 1) {
      const lots = Array.from({ length: next(8) }, (_, index) => lot(`l${round}-${index}`, day(next(40)),
        units(1 + next(3), next(3), next(2), next(2)), 1000 + next(900000), item()));
      const sales = Array.from({ length: next(8) }, (_, index) => sale(`s${round}-${index}`, day(20 + next(70)), 1 + next(3), 1000 + next(900000),
        item()));
      const v1 = metalsAssignment(lots, sales, ASOF);
      assert.deepEqual(metalsAssignment(lots, sales, ASOF, { fungible: [] }), v1, `round ${round}: an empty policy`);
      assert.deepEqual(metalsAssignment(lots, sales, ASOF, { fungible: ['XPT', 'XPD'] }), v1, `round ${round}: other metals named`);
      // Naming silver leaves gold as v1 reads it: its classes and unknown content, its sale lines and their cycles.
      const gold = (result: MetalsAssignment) => ({
        ledger: result.metals.find((entry) => entry.metal === 'XAU') ?? null,
        sales: result.sales.filter((line) => line.metal === 'XAU'),
        cycles: result.cycles.filter((cycle) => sales.find((entry) => entry.key === cycle.saleKey)!.metal === 'XAU'),
      });
      assert.deepEqual(gold(metalsAssignment(lots, sales, ASOF, { fungible: ['XAG'] })), gold(v1), `round ${round}: silver named`);
      // Both named: every class keeps the identities.
      for (const entry of metalsAssignment(lots, sales, ASOF, { fungible: ['XAU', 'XAG'] }).metals) {
        for (const ledger of entry.classes) identities(ledger, `round ${round} ${ledger.key}`);
      }
      cycles += v1.cycles.length;
    }
    assert.ok(cycles > 50, 'the generated ledgers assign purchases');
  });

  it('assigns a metal it names oldest first across forms, one class per fine content; metal and fine content still apart', () => {
    const lots = [
      lot('bar', '2030-01-10', units(1), 200000),
      lot('coin', '2030-01-11', units(1), 210000, { form: 'coin' }),
      lot('none', '2030-01-12', units(1), 220000, { form: null }),
      lot('half', '2030-01-13', units(1), 100000, { form: 'round', fineTroyOzPerUnit: rational(1n, 2n) }),
      lot('silver', '2030-01-14', units(1), 3000, { metal: 'XAG', form: 'coin' }),
    ];
    const sales = [
      sale('unstated', '2030-02-01', 2, 460000, { form: null }),
      sale('round', '2030-02-02', 2, 470000, { form: 'round' }),
      sale('silver', '2030-02-03', 1, 3100, { metal: 'XAG', form: 'bar' }),
    ];
    const v1 = metalsAssignment(lots, sales, ASOF);
    // By form (v1) the unstated sale finds the one unstated lot, the round sale none, and the silver bar sale no bar.
    assert.deepEqual(v1.cycles.map((cycle) => [cycle.saleKey, cycle.lotKey]), [['unstated', 'none']]);
    const result = metalsAssignment(lots, sales, ASOF, { fungible: ['XAU'] });
    assert.deepEqual(result.cycles.map((cycle) => [cycle.saleKey, cycle.lotKey]), [['unstated', 'bar'], ['unstated', 'coin'], ['round', 'none']]);
    assert.deepEqual(result.metals.map((entry) => [entry.metal, entry.classes.map((ledger) => ledger.key)]), [
      ['XAG', ['XAG|bar|1/1', 'XAG|coin|1/1']],
      ['XAU', ['XAU|any|1/1', 'XAU|any|1/2']],
    ]);
    const [whole, half] = result.metals.find((entry) => entry.metal === 'XAU')!.classes;
    // Four sold against three bought before them: the one unit left unmatched is sold − bought.
    assert.deepEqual([whole.form, whole.units.delivered, whole.units.sold, whole.units.unmatched, whole.units.held], ['any', 3, 4, 1, 0]);
    assert.deepEqual([half.form, half.units.delivered, half.units.sold, half.units.held], ['any', 1, 0, 1]);
    assert.deepEqual(result.sales.map((line) => [line.key, line.matchedUnits, line.unmatchedUnits]), [['unstated', 2, 0], ['round', 1, 1], ['silver', 0, 1]]);
    // Silver, not named, reads as v1: no class of it infers a delivery.
    assert.deepEqual(result.metals.find((entry) => entry.metal === 'XAG'), v1.metals.find((entry) => entry.metal === 'XAG'));
    assert.deepEqual(result.metals.flatMap((entry) => entry.classes.map((ledger) => ['deliveryInferred' in ledger, ledger.deliveryInferred ?? null])),
      [[false, null], [false, null], [true, 0], [true, 0]]);
    for (const entry of result.metals) for (const ledger of entry.classes) identities(ledger);
  });

  it('reads a unit a sale took from awaiting as delivered, as of its agreed day: H, A − S_A and every cent unchanged', () => {
    // One lot of 3 bars, 1 delivered and 2 awaiting; a sale of 2 takes the delivered one first, then one awaiting.
    const lots = [lot('a', '2030-01-10', units(1, 2), 300000)];
    const sales = [sale('s', '2030-02-01', 2, 460000)];
    const v1 = metalsAssignment(lots, sales, ASOF);
    assert.deepEqual(onlyClass(v1).units, { delivered: 1, awaiting: 2, sold: 2, soldFromDelivered: 1, soldFromAwaiting: 1, unmatched: 0, held: 0,
      awaitingUnassigned: 1 });
    const result = metalsAssignment(lots, sales, ASOF, { fungible: ['XAU'] });
    const inferred = onlyClass(result);
    assert.deepEqual(inferred.units, { delivered: 2, awaiting: 1, sold: 2, soldFromDelivered: 2, soldFromAwaiting: 0, unmatched: 0, held: 0,
      awaitingUnassigned: 1 });
    assert.equal(inferred.deliveryInferred, 1);
    assert.deepEqual([inferred.key, inferred.cents, inferred.heldCostIncompleteLots, inferred.dateUnknownLots],
      ['XAU|any|1/1', onlyClass(v1).cents, onlyClass(v1).heldCostIncompleteLots, onlyClass(v1).dateUnknownLots]);
    assert.deepEqual([result.cycles, result.sales], [v1.cycles, v1.sales]);
    identities(inferred);
    // As of a day before the sale nothing was sold, so nothing is inferred: two units still await delivery.
    const before = onlyClass(metalsAssignment(lots, sales, '2030-01-31', { fungible: ['XAU'] }));
    assert.deepEqual([before.units.delivered, before.units.awaiting, before.units.sold, before.deliveryInferred], [1, 2, 0, 0]);
  });
});
