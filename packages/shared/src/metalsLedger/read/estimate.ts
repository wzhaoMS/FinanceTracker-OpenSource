/**
 * `METALS_ESTIMATE_RULE` v1 ('metals-estimate-nearest-v1', ROOT's item 4b): an estimated cost for sold units the
 * assignment left with no recorded purchase, for the metals the owner's switch names (`HOLDR_METALS_ESTIMATE_UNMATCHED`
 * in holdr.conf; none by default, and then nothing here runs). "Estimated from your nearest purchase of the same kind —
 * not a recorded purchase."
 *
 * A label, never a fact. The assignment and every figure it makes stay exactly as they are: an estimate is never a
 * purchase, a lot, a cycle, a holding, a funding row or a card link, and it takes no unit from any lot (any number of
 * sold units may read one lot's unit cost). Only a sale's cost basis and profit or loss, and a period's, read it, each
 * split into its recorded and its estimated part.
 *
 * - Which units: every unit of a sale line with no recorded purchase (`unmatchedUnits`, whatever its reason), when the
 *   switch names the line's metal. Only a line of known content has such units: content-unknown lines are in no class.
 * - The candidates: the lots of the line's class that the assignment read (ordered on or before its date), each with a
 *   kept unit as of that date (delivered and kept, or on the way; never a lot whose every unit was cancelled or
 *   returned) and a complete cost above zero (a lot of no cost never sets a price, ROOT's fix: its first unit's share is
 *   then at least a cent). The class is the assignment's own: the caller gives the class form it assigned
 *   with, so the owner's fungible policy (`HOLDR_METALS_FUNGIBLE`), when it names the metal, holds here too. A class
 *   with no candidate leaves its units unestimated: they stay `unmatched-sales`.
 * - The nearest candidate: by order date to the sale's agreed day, in whole days, before or after it (an estimate reads
 *   a price, never which unit was sold); a tie goes to the earlier order date, then the order key, the line ordinal and
 *   the lot key.
 * - The unit cost: the share of the lot's cost its first unit takes when that cost is split over its ordered units by
 *   largest remainder, earlier units first (the assignment's split; a lot's first unit is kept whenever any is). It is
 *   at most a cent above the lot's average cost per unit when the cost doesn't divide evenly.
 * - A line's estimate: those units × the unit cost. Its proceeds are those units' nets (the assignment's
 *   `unmatchedNetMinor`), and its profit or loss is the proceeds less the estimated cost.
 *
 * Pure: no file system, network or clock.
 */

import { metalsUnitSplit } from '../allocation.js';
import { METALS, type Metal, type MetalForm } from '../model.js';
import { add, equals, multiply, rational, ZERO, type Rational } from '../rational.js';
import {
  metalsClassForm,
  type MetalsAssignment,
  type MetalsAssignmentLot,
  type MetalsAssignmentSale,
  type MetalsClassForm,
} from './assignment.js';

export const METALS_ESTIMATE_RULE = 'metals-estimate-nearest-v1' as const;

/** One sale line's estimate: its units with no recorded purchase, at the unit cost of the nearest lot of its class. */
export interface MetalsEstimateLine {
  saleKey: string;
  /** The line's class, as the assignment keys it. */
  classKey: string;
  agreedDay: string;
  units: number;
  /** Those units' fine troy ounces. */
  fineTroyOz: Rational;
  unitCostMinor: number;
  costMinor: number;
  /** Those units' nets, and the nets less the estimated cost. */
  proceedsMinor: number;
  profitMinor: number;
  /**
   * The lot whose unit cost it reads. Nothing is assigned: no cycle is added and the lot keeps every unit (the sale may
   * still hold a cycle of the same lot for units it was assigned).
   */
  lotKey: string;
  orderKey: string;
  orderDate: string;
  /** The sale's agreed day less the lot's order date, in days, as a cycle's: negative when it was ordered after the sale. */
  daysFromOrderToSale: number;
}

/** A class's units with no recorded purchase: those with an estimate (and their estimated cost), and those with none. */
export interface MetalsEstimateClass {
  classKey: string;
  metal: Metal;
  units: number;
  costMinor: number;
  unestimatedUnits: number;
}

export interface MetalsEstimates {
  rule: typeof METALS_ESTIMATE_RULE;
  asOf: string;
  /** The metals estimated, in METALS order. */
  metals: Metal[];
  /** Each sale line with an estimate, in the assignment's sale order. */
  lines: MetalsEstimateLine[];
  /** The sale lines of those metals with units no recorded purchase was assigned to, and no estimate, in the same order. */
  unestimated: string[];
  /** Each class of those metals with units no recorded purchase was assigned to, by class key. */
  classes: MetalsEstimateClass[];
}

const DAY_MS = 86_400_000;
/** A YYYY-MM-DD day as whole days since the epoch. */
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Between two lots as near as each other to a sale: the earlier order date, then the order key, line ordinal and key. */
const tiesBefore = (a: MetalsAssignmentLot, b: MetalsAssignmentLot) => (compareText(a.orderDate, b.orderDate)
  || compareText(a.orderKey, b.orderKey) || a.ordinal - b.ordinal || compareText(a.key, b.key)) < 0;

/**
 * The estimates over one assignment, from the same lots and sales it read and the class form it assigned with (none:
 * metals-assignment-v1's). `metals` is the switch's list; with none, nothing is estimated.
 */
export function metalsUnmatchedEstimates(
  assignment: MetalsAssignment,
  inputs: { readonly lots: readonly MetalsAssignmentLot[]; readonly sales: readonly MetalsAssignmentSale[] },
  metals: readonly Metal[],
  classForm: (metal: Metal, form: MetalForm | null) => MetalsClassForm = (_metal, form) => metalsClassForm(form),
): MetalsEstimates {
  const named = METALS.filter((metal) => metals.includes(metal));
  /** The assignment's class of an item of known content: a class it doesn't have is a caller's wiring error. */
  const classOf = (metal: Metal, form: MetalForm | null, fine: Rational, item: string): string => {
    const ledger = assignment.metals.find((entry) => entry.metal === metal)?.classes
      .find((entry) => entry.form === classForm(metal, form) && equals(entry.fineTroyOzPerUnit, fine));
    if (!ledger) throw new RangeError(`metalsUnmatchedEstimates: ${item} is in no class of the assignment`);
    return ledger.key;
  };

  const candidates = new Map<string, Array<{ lot: MetalsAssignmentLot; day: number }>>();
  for (const lot of inputs.lots) {
    if (lot.orderDate > assignment.asOf || lot.metal === null || lot.fineTroyOzPerUnit === null || !named.includes(lot.metal)) continue;
    if (lot.units.delivered + lot.units.awaiting === 0 || !lot.costComplete || lot.costMinor <= 0) continue;
    const key = classOf(lot.metal, lot.form, lot.fineTroyOzPerUnit, `lot ${lot.key}`);
    const list = candidates.get(key) ?? [];
    list.push({ lot, day: dayNumber(lot.orderDate) });
    candidates.set(key, list);
  }

  const saleInputs = new Map(inputs.sales.map((sale) => [sale.key, sale]));
  const lines: MetalsEstimateLine[] = [];
  const unestimated: string[] = [];
  const classes = new Map<string, MetalsEstimateClass>();
  for (const line of assignment.sales) {
    if (line.unmatchedUnits === 0 || line.metal === null || !named.includes(line.metal)) continue;
    const sale = saleInputs.get(line.key);
    if (sale === undefined || sale.fineTroyOzPerUnit === null) throw new RangeError(`metalsUnmatchedEstimates: sale ${line.key} is not the assignment's`);
    const classKey = classOf(line.metal, sale.form, sale.fineTroyOzPerUnit, `sale ${line.key}`);
    let totals = classes.get(classKey);
    if (!totals) classes.set(classKey, (totals = { classKey, metal: line.metal, units: 0, costMinor: 0, unestimatedUnits: 0 }));
    const saleDay = dayNumber(line.agreedDay);
    let lot: MetalsAssignmentLot | undefined;
    let nearest = Infinity;
    for (const candidate of candidates.get(classKey) ?? []) {
      const distance = Math.abs(candidate.day - saleDay);
      if (distance < nearest || (distance === nearest && lot !== undefined && tiesBefore(candidate.lot, lot))) {
        lot = candidate.lot;
        nearest = distance;
      }
    }
    if (lot === undefined) {
      unestimated.push(line.key);
      totals.unestimatedUnits += line.unmatchedUnits;
      continue;
    }
    const unitCostMinor = metalsUnitSplit(lot.costMinor, lot.units.ordered)[0];
    const costMinor = unitCostMinor * line.unmatchedUnits;
    lines.push({
      saleKey: line.key, classKey, agreedDay: line.agreedDay, units: line.unmatchedUnits,
      fineTroyOz: multiply(sale.fineTroyOzPerUnit, rational(BigInt(line.unmatchedUnits))), unitCostMinor, costMinor,
      proceedsMinor: line.unmatchedNetMinor, profitMinor: line.unmatchedNetMinor - costMinor,
      lotKey: lot.key, orderKey: lot.orderKey, orderDate: lot.orderDate, daysFromOrderToSale: saleDay - dayNumber(lot.orderDate),
    });
    totals.units += line.unmatchedUnits;
    totals.costMinor += costMinor;
  }

  return {
    rule: METALS_ESTIMATE_RULE,
    asOf: assignment.asOf,
    metals: named,
    lines,
    unestimated,
    classes: [...classes.values()].sort((a, b) => compareText(a.classKey, b.classKey)),
  };
}

/** What a period's profit or loss sums with the estimates, part by part. */
export interface MetalsEstimatedProfit {
  /** Null when, with sales in the period, it sums nothing: no cycle with a complete cost and no estimate counted. */
  valueMinor: number | null;
  /** The counted cycles' profit or loss and cost (their sale lines' recorded purchases); null when none is counted. */
  recorded: { profitMinor: number | null; costMinor: number | null };
  /** The counted estimates: their profit or loss, cost, sale lines, units and fine troy ounces. */
  estimated: { profitMinor: number; costMinor: number; lines: number; units: number; troyOz: Rational };
  /** The period's units with no recorded purchase and no estimate. */
  unestimatedUnits: number;
}

/**
 * Profit or loss on sales agreed in [from, to] for one metal, as `metalsProfitOnSales` counts it, with the estimates in:
 * on the troy-oz basis (every sale line in the period of known content), every cycle with a complete cost and every
 * estimate; on the sale-lines basis, the cycles and estimates of the lines known with their estimates (every unit
 * matched at a complete cost or estimated). With no estimate it is `metalsProfitOnSales`'s value exactly. The
 * coverage's `known` is still the recorded part; `estimated` is the rest of what the value sums (troy ounces on the
 * troy-oz basis, the lines known only with their estimate on the sale-lines basis).
 */
export function metalsProfitOnSalesWithEstimates(
  assignment: MetalsAssignment,
  estimates: MetalsEstimates,
  metal: Metal,
  from: string,
  to: string,
): MetalsEstimatedProfit {
  const lines = assignment.sales.filter((line) => line.metal === metal && line.agreedDay >= from && line.agreedDay <= to);
  const estimateOf = new Map(estimates.lines.map((entry) => [entry.saleKey, entry]));
  const byTroyOz = lines.every((line) => line.contentKnown);
  const counted = byTroyOz ? lines
    : lines.filter((line) => line.contentKnown && !line.costIncomplete && (line.unmatchedUnits === 0 || estimateOf.has(line.key)));
  const keys = new Set(counted.map((line) => line.key));
  const cycles = assignment.cycles.filter((cycle) => cycle.costComplete && keys.has(cycle.saleKey));
  const used = counted.flatMap((line) => estimateOf.get(line.key) ?? []);
  const recordedProfit = cycles.reduce((total, cycle) => total + cycle.profitMinor!, 0);
  const estimated = {
    profitMinor: used.reduce((total, entry) => total + entry.profitMinor, 0),
    costMinor: used.reduce((total, entry) => total + entry.costMinor, 0),
    // A line with an estimate has units with no recorded purchase, so it is never known without it.
    lines: used.length,
    units: used.reduce((total, entry) => total + entry.units, 0),
    troyOz: used.reduce((total, entry) => add(total, entry.fineTroyOz), ZERO),
  };
  const unestimatedUnits = lines.reduce((total, line) => total + (estimateOf.has(line.key) ? 0 : line.unmatchedUnits), 0);
  if (lines.length === 0) return { valueMinor: 0, recorded: { profitMinor: 0, costMinor: 0 }, estimated, unestimatedUnits };
  const recorded = cycles.length === 0 ? { profitMinor: null, costMinor: null }
    : { profitMinor: recordedProfit, costMinor: cycles.reduce((total, cycle) => total + cycle.costMinor, 0) };
  const valueMinor = cycles.length === 0 && used.length === 0 ? null : recordedProfit + estimated.profitMinor;
  return { valueMinor, recorded, estimated, unestimatedUnits };
}
