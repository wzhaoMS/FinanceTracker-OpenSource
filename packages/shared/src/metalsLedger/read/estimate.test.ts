import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { metalsUnitSplit } from '../allocation.js';
import type { Metal, MetalForm } from '../model.js';
import { add, equals, formatRational, multiply, rational, ZERO, type Rational } from '../rational.js';
import {
  metalsAssignment,
  metalsAssignmentClassForm,
  metalsProfitOnSales,
  type MetalsAssignment,
  type MetalsAssignmentLot,
  type MetalsAssignmentPolicy,
  type MetalsAssignmentSale,
} from './assignment.js';
import { METALS_ESTIMATE_RULE, metalsProfitOnSalesWithEstimates, metalsUnmatchedEstimates, type MetalsEstimates } from './estimate.js';
import type { MetalsLotUnits } from './lifecycle.js';

/** Synthetic ledgers only: invented keys, dates, quantities and cents. */
const ONE_OZ = rational(1n);
const HALF_OZ = rational(1n, 2n);
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

/** The assignment as of ASOF and its estimates, as the views build both: one set of lots and sales, one class form. */
function estimate(lots: MetalsAssignmentLot[], sales: MetalsAssignmentSale[], metals: Metal[] = ['XAU'], policy?: MetalsAssignmentPolicy) {
  const assignment = metalsAssignment(lots, sales, ASOF, policy);
  const estimates = metalsUnmatchedEstimates(assignment, { lots, sales }, metals,
    (metal, form) => metalsAssignmentClassForm(metal, form, policy));
  return { assignment, estimates };
}
const lotOf = (estimates: MetalsEstimates, saleKey: string) => estimates.lines.find((line) => line.saleKey === saleKey)?.lotKey ?? null;

describe('estimates: the nearest purchase of the class, for sold units with no recorded purchase (metals-estimate-nearest-v1)', () => {
  it('estimates nothing while the switch names no metal, and only the metals it names', () => {
    const lots = [lot('a', '2030-01-10', units(1), 200000)];
    const sales = [sale('s', '2030-01-05', 1, 210000), sale('t', '2030-01-05', 1, 30000, { metal: 'XAG' })];
    const none = estimate(lots, sales, []).estimates;
    assert.deepEqual(none, { rule: METALS_ESTIMATE_RULE, asOf: ASOF, metals: [], lines: [], unestimated: [], classes: [] });
    assert.deepEqual(estimate(lots, sales, ['XPT']).estimates.lines, []);
    const gold = estimate(lots, sales, ['XAG', 'XAU']).estimates;
    assert.deepEqual(gold.metals, ['XAU', 'XAG']);
    assert.deepEqual(gold.lines, [{
      saleKey: 's', classKey: 'XAU|bar|1/1', agreedDay: '2030-01-05', units: 1, fineTroyOz: ONE_OZ, unitCostMinor: 200000, costMinor: 200000,
      proceedsMinor: 210000, profitMinor: 10000, lotKey: 'a', orderKey: 'order-a', orderDate: '2030-01-10', daysFromOrderToSale: -5,
    }]);
    // Silver has no purchase of its class: its units stay without an estimate.
    assert.deepEqual(gold.unestimated, ['t']);
    assert.deepEqual(gold.classes, [
      { classKey: 'XAG|bar|1/1', metal: 'XAG', units: 0, costMinor: 0, unestimatedUnits: 1 },
      { classKey: 'XAU|bar|1/1', metal: 'XAU', units: 1, costMinor: 200000, unestimatedUnits: 0 },
    ]);
  });

  it('reads the nearest lot by order date, before or after the sale, whether or not its units were assigned', () => {
    // The first unit takes lot 1; the second has none ordered by 02-01. Lot 2 (28 days after) is nearer than lot 1 (31 before).
    const lots = [lot('1', '2030-01-01', units(1), 190000), lot('2', '2030-03-01', units(1), 230000)];
    const { assignment, estimates } = estimate(lots, [sale('s', '2030-02-01', 2, 420000)]);
    assert.equal(assignment.sales[0].unmatchedUnits, 1);
    assert.deepEqual(estimates.lines.map((line) => [line.lotKey, line.units, line.unitCostMinor, line.daysFromOrderToSale, line.proceedsMinor]),
      [['2', 1, 230000, -28, 210000]]);
    // An assigned lot still gives its price: a sale 40 days after lot 1 and 19 before lot 2 reads lot 2, one 10 days after lot 1 reads lot 1.
    const later = estimate(lots, [sale('x', '2030-01-01', 1, 200000), sale('y', '2030-01-11', 1, 200000), sale('z', '2030-02-10', 1, 200000)]);
    assert.deepEqual([lotOf(later.estimates, 'x'), lotOf(later.estimates, 'y'), lotOf(later.estimates, 'z')], [null, '1', '2']);
  });

  it('breaks a tie by the earlier order date, then the order key, the line ordinal and the lot key', () => {
    // 3 days after and 3 days before, the later listed first: the earlier. The first sale takes lot b, so the second has
    // no purchase.
    const before = estimate([lot('a', '2030-02-13', units(1), 210000), lot('b', '2030-02-07', units(1), 200000)],
      [sale('first', '2030-02-08', 1, 205000), sale('second', '2030-02-10', 1, 206000)]);
    assert.equal(lotOf(before.estimates, 'second'), 'b');
    // The same day: the order key, then the line ordinal within one order, then the lot key; the loser listed first each time.
    const later = (extra: Array<Partial<MetalsAssignmentLot>>) => lotOf(estimate(extra.map((patch, index) =>
      lot(`l${index}`, '2030-03-01', units(1), 200000 + index, patch)), [sale('s', '2030-02-01', 1, 200000)]).estimates, 's');
    assert.equal(later([{ orderKey: 'order-x' }, { orderKey: 'order-w' }]), 'l1');
    assert.equal(later([{ orderKey: 'order-w', ordinal: 1 }, { orderKey: 'order-w', ordinal: 0 }]), 'l1');
    assert.equal(later([{ key: 'l1', orderKey: 'order-w' }, { key: 'l0', orderKey: 'order-w' }]), 'l0');
  });

  it('reads only a lot with a kept unit and a complete cost, at its first unit\'s share of the cost', () => {
    const sales = [sale('s', '2030-02-01', 2, 400000)];
    const lots = [
      lot('cancelled', '2030-02-02', units(0, 0, 0, 1), 200000),
      lot('returned', '2030-02-03', units(0, 0, 1), 200000),
      lot('incomplete', '2030-02-04', units(1), 200000, { costComplete: false }),
      lot('kept', '2030-02-05', units(2, 0, 1), 600001),
      lot('far', '2030-04-01', units(1), 1),
    ];
    const { estimates } = estimate(lots, sales);
    // 600001 over 3 ordered units by largest remainder: 200001, 200000, 200000; the first unit is kept.
    assert.deepEqual(estimates.lines.map((line) => [line.lotKey, line.unitCostMinor, line.costMinor, line.profitMinor]),
      [['kept', 200001, 400002, -2]]);
    assert.deepEqual(metalsUnitSplit(600001, 3), [200001, 200000, 200000]);
    // A lot still on the way is kept.
    assert.equal(lotOf(estimate([lot('awaiting', '2030-02-02', units(0, 1), 199000)], sales).estimates, 's'), 'awaiting');
    // With only cancelled, returned or incomplete lots, none.
    const none = estimate(lots.slice(0, 3), sales).estimates;
    assert.deepEqual([none.lines, none.unestimated, none.classes], [[], ['s'], [{ classKey: 'XAU|bar|1/1', metal: 'XAU', units: 0, costMinor: 0,
      unestimatedUnits: 2 }]]);
  });

  it('never reads a lot of no cost: a $0 lot nearer than a priced one gives way to it, and alone gives none (ROOT\'s fix)', () => {
    const sales = [sale('s', '2030-02-01', 1, 200000)];
    const free = lot('free', '2030-02-02', units(1), 0);
    const priced = lot('priced', '2030-03-01', units(1), 205000);
    assert.deepEqual(estimate([free, priced], sales).estimates.lines.map((line) => [line.lotKey, line.unitCostMinor]), [['priced', 205000]]);
    const alone = estimate([free], sales).estimates;
    assert.deepEqual([alone.lines, alone.unestimated, alone.classes.map((entry) => [entry.units, entry.unestimatedUnits])], [[], ['s'], [[0, 1]]]);
    // A lot of a cent over two units still reads: its first unit takes the cent.
    assert.deepEqual(estimate([lot('cent', '2030-02-02', units(2), 1)], sales).estimates.lines.map((line) => line.unitCostMinor), [1]);
  });

  it('keeps classes apart by form and fine content, and reads the fungible policy\'s class across forms', () => {
    const lots = [
      lot('coin', '2030-02-05', units(1), 215000, { form: 'coin' }),
      lot('half', '2030-02-03', units(1), 110000, { fineTroyOzPerUnit: HALF_OZ }),
      lot('bar', '2030-05-01', units(1), 205000),
    ];
    const sales = [sale('s', '2030-02-02', 1, 220000)];
    // v1: the bar class has the bar alone (the coin and the half ounce are other classes), all ordered after the sale.
    const v1 = estimate(lots, sales).estimates;
    assert.deepEqual(v1.lines.map((line) => [line.classKey, line.lotKey, line.unitCostMinor]), [['XAU|bar|1/1', 'bar', 205000]]);
    // Fungible: one class across forms (fine content still apart), where the coin is nearer.
    const fungible = estimate(lots, sales, ['XAU'], { fungible: ['XAU'] }).estimates;
    assert.deepEqual(fungible.lines.map((line) => [line.classKey, line.lotKey, line.unitCostMinor]), [['XAU|any|1/1', 'coin', 215000]]);
    // A class form other than the assignment's is a wiring error, never a silent estimate.
    const assignment = metalsAssignment(lots, sales, ASOF);
    assert.throws(() => metalsUnmatchedEstimates(assignment, { lots, sales }, ['XAU'], () => 'any'), RangeError);
    assert.deepEqual(metalsUnmatchedEstimates(assignment, { lots, sales }, ['XAU']), v1);
  });

  it('reads only lots the assignment read: one ordered after its day is no candidate', () => {
    const lots = [lot('later', '2030-07-01', units(1), 1), lot('kept', '2030-01-01', units(1), 200000)];
    const { estimates } = estimate(lots, [sale('a', '2030-01-02', 1, 200000), sale('b', '2030-06-29', 1, 210000)]);
    assert.deepEqual(estimates.lines.map((line) => [line.saleKey, line.lotKey]), [['b', 'kept']]);
  });

  it('never changes the assignment: no cycle, no assigned unit, no lot cost', () => {
    const lots = [lot('a', '2030-03-01', units(2), 400000)];
    const sales = [sale('s', '2030-02-01', 1, 210000), sale('t', '2030-04-01', 1, 220000)];
    const assignment = metalsAssignment(lots, sales, ASOF);
    const before = structuredClone(assignment);
    const estimates = metalsUnmatchedEstimates(assignment, { lots, sales }, ['XAU']);
    assert.deepEqual(assignment, before);
    assert.deepEqual(estimates.lines.map((line) => line.lotKey), ['a']);
    assert.deepEqual(assignment.cycles.map((cycle) => [cycle.lotKey, cycle.saleKey, cycle.units]), [['a', 't', 1]]);
    assert.deepEqual(assignment.metals[0].classes[0].units, {
      delivered: 2, awaiting: 0, sold: 2, soldFromDelivered: 1, soldFromAwaiting: 0, unmatched: 1, held: 1, awaitingUnassigned: 0,
    });
  });
});

describe('estimates: a period\'s profit or loss, recorded and estimated', () => {
  const lots = [lot('a', '2030-01-10', units(1), 200000), lot('later', '2030-05-01', units(1), 230000)];
  const known = sale('known', '2030-02-01', 1, 210000);
  const unmatched = sale('unmatched', '2030-04-01', 1, 220000);

  it('on the troy-oz basis, every cycle with a complete cost and every estimate', () => {
    const { assignment, estimates } = estimate(lots, [known, unmatched]);
    const valued = metalsProfitOnSalesWithEstimates(assignment, estimates, 'XAU', '2030-01-01', '2030-12-31');
    assert.deepEqual(valued, {
      valueMinor: 0, recorded: { profitMinor: 10000, costMinor: 200000 },
      estimated: { profitMinor: -10000, costMinor: 230000, lines: 1, units: 1, troyOz: ONE_OZ }, unestimatedUnits: 0,
    });
    assert.equal(metalsProfitOnSales(assignment, 'XAU', '2030-01-01', '2030-12-31').profit.value, 10000);
    // A period with the estimated sale alone: its estimate only.
    assert.equal(metalsProfitOnSalesWithEstimates(assignment, estimates, 'XAU', '2030-03-01', '2030-12-31').valueMinor, -10000);
    // No sale: zero, as the recorded rule says; only units with no estimate: unknown, never zero.
    assert.deepEqual(metalsProfitOnSalesWithEstimates(assignment, estimates, 'XAU', '2031-01-01', '2031-12-31'), {
      valueMinor: 0, recorded: { profitMinor: 0, costMinor: 0 }, estimated: { profitMinor: 0, costMinor: 0, lines: 0, units: 0, troyOz: ZERO },
      unestimatedUnits: 0,
    });
    const silver = estimate([], [sale('s', '2030-04-01', 2, 60000, { metal: 'XAG' })], ['XAG']);
    assert.deepEqual(metalsProfitOnSalesWithEstimates(silver.assignment, silver.estimates, 'XAG', '2030-01-01', '2030-12-31'), {
      valueMinor: null, recorded: { profitMinor: null, costMinor: null }, estimated: { profitMinor: 0, costMinor: 0, lines: 0, units: 0, troyOz: ZERO },
      unestimatedUnits: 2,
    });
  });

  it('on the sale-lines basis, the lines known with their estimate: never one whose recorded cost is incomplete', () => {
    const content = sale('content', '2030-03-01', 1, 50000, { fineTroyOzPerUnit: null });
    const incomplete = [lot('a', '2030-01-10', units(1), 200000, { costComplete: false }), lots[1]];
    const sales = [known, unmatched, content];
    const { assignment, estimates } = estimate(lots, sales);
    assert.equal(metalsProfitOnSales(assignment, 'XAU', '2030-01-01', '2030-12-31').coverage.basis, 'sale-lines');
    assert.deepEqual(metalsProfitOnSalesWithEstimates(assignment, estimates, 'XAU', '2030-01-01', '2030-12-31'), {
      valueMinor: 0, recorded: { profitMinor: 10000, costMinor: 200000 },
      estimated: { profitMinor: -10000, costMinor: 230000, lines: 1, units: 1, troyOz: ONE_OZ }, unestimatedUnits: 0,
    });
    // A two-unit sale with one unit from an incomplete cost and one estimated isn't known: neither part counts.
    const both = sale('both', '2030-02-01', 2, 420000);
    const mixed = estimate(incomplete, [both, content]);
    assert.deepEqual(mixed.estimates.lines.map((line) => line.saleKey), ['both']);
    assert.deepEqual(metalsProfitOnSalesWithEstimates(mixed.assignment, mixed.estimates, 'XAU', '2030-01-01', '2030-12-31'), {
      valueMinor: null, recorded: { profitMinor: null, costMinor: null }, estimated: { profitMinor: 0, costMinor: 0, lines: 0, units: 0, troyOz: ZERO },
      unestimatedUnits: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Seeded property: the nearest candidate, by brute force, and every sum
// ---------------------------------------------------------------------------

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

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const FORMS: Array<MetalForm | null> = ['bar', 'ingot', 'coin', 'round', null];
const FINES: Rational[] = [ONE_OZ, HALF_OZ];

function syntheticLedger(next: (bound: number) => number): { lots: MetalsAssignmentLot[]; sales: MetalsAssignmentSale[] } {
  const metalOf = (): Metal => (next(5) === 0 ? 'XAG' : 'XAU');
  // Lots every 30 days (the last after ASOF) and sales every 15, so lots share days and sales fall midway between them.
  const lots = Array.from({ length: next(10) }, (_, index) => lot(`lot-${index}`, addDays('2030-01-01', 30 * next(8)),
    units(next(3), next(2), next(2), next(2) === 0 ? 1 : 0), next(10) === 0 ? 0 : 100000 + next(300000), {
      orderKey: `order-${next(4)}`, ordinal: next(2), metal: metalOf(), form: FORMS[next(FORMS.length)], fineTroyOzPerUnit: FINES[next(2)],
      costComplete: next(8) !== 0,
    })).filter((entry) => entry.units.ordered > 0);
  const sales = Array.from({ length: 1 + next(6) }, (_, index) => sale(`sale-${index}`, addDays('2030-01-01', 15 * next(12)), 1 + next(3),
    100000 + next(600000), { metal: metalOf(), form: FORMS[next(FORMS.length)], fineTroyOzPerUnit: next(10) === 0 ? null : FINES[next(2)],
      cancelled: next(12) === 0 }));
  return { lots, sales };
}

/**
 * The candidate the rule names for a sale of `metal`, by brute force over every lot (no code the estimate shares), and how
 * many candidates are as near as it.
 */
function expectedLot(assignment: MetalsAssignment, lots: readonly MetalsAssignmentLot[], target: MetalsAssignmentSale, metal: Metal,
  classForm: (metal: Metal, form: MetalForm | null) => string): { best: MetalsAssignmentLot | null; asNear: number } {
  const distance = (entry: MetalsAssignmentLot) => Math.abs(dayOf(entry.orderDate) - dayOf(target.agreedDay));
  const order = (entry: MetalsAssignmentLot) => [entry.orderDate, entry.orderKey, String(entry.ordinal).padStart(4, '0'), entry.key].join('\u0000');
  const candidates = lots.filter((entry) => entry.orderDate <= assignment.asOf && entry.metal === metal && entry.fineTroyOzPerUnit !== null
    && equals(entry.fineTroyOzPerUnit, target.fineTroyOzPerUnit!) && classForm(metal, entry.form) === classForm(metal, target.form)
    && entry.units.delivered + entry.units.awaiting > 0 && entry.costComplete && entry.costMinor > 0);
  let best: MetalsAssignmentLot | null = null;
  for (const candidate of candidates) {
    if (best === null || distance(candidate) < distance(best) || (distance(candidate) === distance(best) && order(candidate) < order(best))) {
      best = candidate;
    }
  }
  return { best, asNear: best === null ? 0 : candidates.filter((entry) => distance(entry) === distance(best!)).length };
}

describe('estimates: a seeded property over synthetic ledgers', () => {
  it('names the nearest candidate, adds up per class, and leaves the period\'s value as the recorded rule\'s without estimates', () => {
    let estimated = 0;
    let unestimated = 0;
    let ties = 0;
    let fungibleRuns = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = seeded(seed);
      const { lots, sales } = syntheticLedger(next);
      const policy: MetalsAssignmentPolicy | undefined = next(2) === 0 ? { fungible: ['XAU'] } : undefined;
      if (policy) fungibleRuns += 1;
      const classForm = (metal: Metal, form: MetalForm | null) => metalsAssignmentClassForm(metal, form, policy);
      const { assignment, estimates } = estimate(lots, sales, ['XAU'], policy);
      const at = `seed ${seed}`;
      const byKey = new Map(estimates.lines.map((line) => [line.saleKey, line]));
      for (const line of assignment.sales) {
        if (line.metal !== 'XAU' || line.unmatchedUnits === 0) {
          assert.ok(!byKey.has(line.key), `${at}: ${line.key} has no estimate`);
          continue;
        }
        const input = sales.find((entry) => entry.key === line.key)!;
        const { best: expected, asNear } = expectedLot(assignment, lots, input, 'XAU', classForm);
        const got = byKey.get(line.key);
        if (expected === null) {
          assert.ok(got === undefined && estimates.unestimated.includes(line.key), `${at}: ${line.key} is unestimated`);
          unestimated += 1;
          continue;
        }
        estimated += 1;
        assert.ok(got, `${at}: ${line.key} is estimated`);
        assert.equal(got.lotKey, expected.key, `${at}: ${line.key} reads the nearest candidate`);
        if (asNear > 1) ties += 1;
        assert.equal(got.unitCostMinor, metalsUnitSplit(expected.costMinor, expected.units.ordered)[0], `${at}: the first unit's share`);
        assert.deepEqual([got.units, got.proceedsMinor, got.costMinor, got.profitMinor],
          [line.unmatchedUnits, line.unmatchedNetMinor, got.unitCostMinor * line.unmatchedUnits, line.unmatchedNetMinor - got.unitCostMinor * line.unmatchedUnits], at);
        assert.ok(equals(got.fineTroyOz, multiply(input.fineTroyOzPerUnit!, rational(BigInt(line.unmatchedUnits)))), at);
        assert.equal(got.daysFromOrderToSale, dayOf(line.agreedDay) - dayOf(expected.orderDate), at);
      }
      // Per class: estimated and unestimated units are the class's units with no recorded purchase, the cost their sum.
      for (const ledger of assignment.metals.find((entry) => entry.metal === 'XAU')?.classes ?? []) {
        const totals = estimates.classes.find((entry) => entry.classKey === ledger.key);
        if (ledger.units.unmatched === 0) {
          assert.equal(totals, undefined, `${at}: ${ledger.key} lists nothing`);
          continue;
        }
        assert.ok(totals, `${at}: ${ledger.key} is listed`);
        assert.equal(totals.units + totals.unestimatedUnits, ledger.units.unmatched, `${at}: ${ledger.key} units`);
        const lines = estimates.lines.filter((entry) => entry.classKey === ledger.key);
        assert.equal(totals.costMinor, lines.reduce((total, entry) => total + entry.costMinor, 0), `${at}: ${ledger.key} cost`);
      }
      // The period's value: with no estimates, the recorded rule's exactly; with them, its parts add up.
      const none = metalsUnmatchedEstimates(assignment, { lots, sales }, [], classForm);
      for (const [from, to] of [['2030-01-01', '2030-12-31'], ['2030-02-01', '2030-03-31'], [addDays('2030-01-01', next(150)), '2030-06-30']]) {
        const recorded = metalsProfitOnSales(assignment, 'XAU', from, to);
        assert.equal(metalsProfitOnSalesWithEstimates(assignment, none, 'XAU', from, to).valueMinor, recorded.profit.value, `${at}: ${from}..${to}`);
        const valued = metalsProfitOnSalesWithEstimates(assignment, estimates, 'XAU', from, to);
        if (valued.valueMinor !== null) assert.equal(valued.valueMinor, (valued.recorded.profitMinor ?? 0) + valued.estimated.profitMinor, at);
        if (recorded.coverage.basis === 'troy-oz') {
          assert.equal(valued.recorded.profitMinor, recorded.profit.value, `${at}: the recorded part is the recorded rule's`);
          assert.equal(formatRational(valued.estimated.troyOz), formatRational(estimates.lines
            .filter((entry) => entry.agreedDay >= from && entry.agreedDay <= to).reduce((total, entry) => add(total, entry.fineTroyOz), ZERO)), at);
        }
      }
    }
    // Not vacuous: estimated and unestimated lines, candidates as near as each other, and both class forms.
    const counts = `estimated ${estimated}, unestimated ${unestimated}, ties ${ties}, fungible ${fungibleRuns}`;
    assert.ok(estimated > 50 && unestimated > 20 && ties > 3 && fungibleRuns > 100 && fungibleRuns < 300, counts);
  });
});
