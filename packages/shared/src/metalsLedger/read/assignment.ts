/**
 * `METALS_ASSIGNMENT_RULE` v1 ('metals-assignment-v1', design v8 §4.4.3): which purchases a sale is assigned, a
 * declared method, not a physical match. "Purchases assigned oldest first — not a confirmed physical match."
 *
 * - A class is (metal, form, fine troy oz per unit); `ingot` counts as `bar`, `bullion` or none is "form not stated".
 *   Only items with fine content are classed; a content-unknown lot or sale is in no class, and its cost or net is
 *   counted once, beside the classes, at its metal.
 * - Sales, in trade-moment order (then order key, line ordinal), are assigned unit by unit the earliest unassigned unit
 *   of their class ordered on or before the agreed day and neither cancelled nor returned: earliest by order date, then
 *   order key, line ordinal and unit ordinal. Within a lot, units are numbered delivered first, then awaiting, then
 *   returned, then cancelled, and costs and nets are split over units by largest remainder, earlier units first.
 * - Units per class: delivered D, awaiting A, sold S = from delivered S_D + from awaiting S_A + unmatched U; recorded
 *   holdings H = D − S_D. The identity D + A = H + (A − S_A) + (S − U) always holds.
 * - Cents per class: Σ sale nets = Σ cycle nets + Σ unmatched nets; Σ lot costs = assigned + held + awaiting and
 *   unassigned + cancelled or returned.
 * - Dates (§4.3): a class lists its lots whose units rest on an undated, year-inferred or contradictory fact (its
 *   holdings are partial); a sale line lists the date-uncertain cancellations or returns that could change its
 *   purchases, which makes its result `date-unknown`.
 * - The owner's fungible policy (`HOLDR_METALS_FUNGIBLE`, `METALS_ASSIGNMENT_FUNGIBLE_RULE`; none by default, and then
 *   everything above holds exactly): a metal the policy names ignores form, one class per fine troy oz per unit, form
 *   `any`, so its bars, ingots, coins, rounds and pieces of no stated form share one first-in, first-out queue (metal and
 *   fine content still separate classes). In such a class a unit a sale took from awaiting reads delivered as of the
 *   sale's agreed day (`deliveryInferred`): D and S_D rise and A and S_A fall by the same, so H, A − S_A, every cent and
 *   every identity are unchanged.
 *
 * Pure: no file system, network or clock.
 */

import { metalsUnitSplit } from '../allocation.js';
import type { Metal, MetalForm } from '../model.js';
import { add, formatRational, multiply, rational, ZERO, type Rational } from '../rational.js';
import { MetalsReasons, metalsMeasure, type MetalsMeasure } from './completeness.js';
import type { MetalsLotUnits } from './lifecycle.js';

export const METALS_ASSIGNMENT_RULE = 'metals-assignment-v1' as const;
/** The rule as the owner's fungible policy reads it: metals-assignment-v1 with the policy's metals fungible across forms. */
export const METALS_ASSIGNMENT_FUNGIBLE_RULE = 'metals-assignment-v1+fungible' as const;

/** A class's form; `any` only for a metal the owner's fungible policy names (`metalsAssignmentClassForm`). */
export type MetalsClassForm = 'bar' | 'coin' | 'round' | 'unstated' | 'any';

/** A class's form: an ingot is a bar; bullion or no form is "form not stated". */
export function metalsClassForm(form: MetalForm | null): MetalsClassForm {
  if (form === 'bar' || form === 'ingot') return 'bar';
  if (form === 'coin' || form === 'round') return form;
  return 'unstated';
}

/** The owner's policy for the assignment (`HOLDR_METALS_FUNGIBLE`): the metals whose units are fungible across forms. */
export interface MetalsAssignmentPolicy {
  fungible: readonly Metal[];
}

/** The class form an item is assigned in: `any` for a metal the policy names, else its form's (`metalsClassForm`). */
export function metalsAssignmentClassForm(metal: Metal, form: MetalForm | null, policy?: MetalsAssignmentPolicy): MetalsClassForm {
  return policy !== undefined && policy.fungible.includes(metal) ? 'any' : metalsClassForm(form);
}

/** A lot as of the assignment's date (its units from metalsLotUnitsAsOf; a lot ordered later is left out). */
export interface MetalsAssignmentLot {
  key: string;
  orderKey: string;
  orderDate: string;
  ordinal: number;
  metal: Metal | null;
  form: MetalForm | null;
  /** Null when the content is held. */
  fineTroyOzPerUnit: Rational | null;
  units: MetalsLotUnits;
  costMinor: number;
  costComplete: boolean;
}

export interface MetalsAssignmentSale {
  key: string;
  orderKey: string;
  /** A UTC instant. */
  tradeMoment: string;
  /** The trade moment's New York date. */
  agreedDay: string;
  ordinal: number;
  metal: Metal | null;
  form: MetalForm | null;
  fineTroyOzPerUnit: Rational | null;
  quantity: number;
  netMinor: number;
  cancelled: boolean;
}

export interface MetalsCycle {
  lotKey: string;
  saleKey: string;
  units: number;
  fineTroyOz: Rational;
  costMinor: number;
  proceedsMinor: number;
  costComplete: boolean;
  /** proceeds − cost when the cost is complete, else unknown. */
  profitMinor: number | null;
  orderDate: string;
  agreedDay: string;
  daysHeld: number;
}

export interface MetalsSaleLine {
  key: string;
  agreedDay: string;
  metal: Metal | null;
  contentKnown: boolean;
  units: number;
  fineTroyOz: Rational | null;
  matchedUnits: number;
  unmatchedUnits: number;
  matchedNetMinor: number;
  unmatchedNetMinor: number;
  /** Every unit matched to a purchase with complete cost. */
  known: boolean;
  /** Matched to a purchase whose cost is incomplete. */
  costIncomplete: boolean;
  /**
   * The lots of its class, ordered on or before its agreed day, whose cancellations or returns as of the date are
   * date-uncertain (lifecycle's assignableDateUnknown) and which could change the purchases it is assigned: it took
   * a unit from that lot or a later one in the class's order, or has unmatched units. Any makes its result
   * date-unknown. A sale served entirely by earlier lots keeps the same purchases whatever those dates are.
   */
  dateUnknownLots: string[];
}

export interface MetalsClassLedger {
  key: string;
  metal: Metal;
  form: MetalsClassForm;
  fineTroyOzPerUnit: Rational;
  units: {
    delivered: number;
    awaiting: number;
    sold: number;
    soldFromDelivered: number;
    soldFromAwaiting: number;
    unmatched: number;
    /** Recorded holdings: delivered and not assigned to a sale. */
    held: number;
    awaitingUnassigned: number;
  };
  cents: {
    saleNets: number;
    cycleNets: number;
    unmatchedNets: number;
    lotCosts: number;
    assignedCosts: number;
    heldCosts: number;
    awaitingUnassignedCosts: number;
    cancelledOrReturnedCosts: number;
  };
  /** Lots whose recorded holdings carry an incomplete cost. */
  heldCostIncompleteLots: string[];
  /** The class's lots whose units as of the date rest on an undated, year-inferred or contradictory fact. */
  dateUnknownLots: string[];
  /**
   * Only in a class of form `any` (the owner's fungible policy): the units sales took from awaiting, which read delivered
   * as of each sale's agreed day (`delivery-inferred`): counted in `delivered` and `soldFromDelivered`, never in
   * `awaiting` or `soldFromAwaiting`.
   */
  deliveryInferred?: number;
}

export interface MetalsContentUnknown {
  lots: string[];
  sales: string[];
  lotCostMinor: number;
  saleNetMinor: number;
}

export interface MetalsMetalLedger {
  metal: Metal;
  classes: MetalsClassLedger[];
  contentUnknown: MetalsContentUnknown;
}

export interface MetalsAssignment {
  asOf: string;
  metals: MetalsMetalLedger[];
  /** Lots and sales whose metal itself is unknown. */
  metalUnknown: MetalsContentUnknown;
  cycles: MetalsCycle[];
  sales: MetalsSaleLine[];
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const classKey = (metal: Metal, form: MetalsClassForm, fine: Rational) => `${metal}|${form}|${formatRational(fine)}`;
const emptyUnknown = (): MetalsContentUnknown => ({ lots: [], sales: [], lotCostMinor: 0, saleNetMinor: 0 });

type UnitState = 'delivered' | 'awaiting' | 'returned' | 'cancelled';

interface LotSlot {
  lot: MetalsAssignmentLot;
  /** Its place in the class's first-in, first-out order. */
  position: number;
  unitCosts: number[];
  states: UnitState[];
  assignable: number[];
  next: number;
  assignedTo: Array<string | null>;
}

/**
 * Assigns every sale agreed on or before `asOf` to purchases, and decomposes units and cents per class. The caller
 * passes each lot's units as of `asOf` and leaves out lots ordered after it. `policy` is the owner's fungible policy
 * (none: metals-assignment-v1 exactly).
 */
export function metalsAssignment(
  lots: readonly MetalsAssignmentLot[],
  sales: readonly MetalsAssignmentSale[],
  asOf: string,
  policy?: MetalsAssignmentPolicy,
): MetalsAssignment {
  const metals = new Map<Metal, { classes: Map<string, MetalsClassLedger>; unknown: MetalsContentUnknown }>();
  const ledgers = new Map<string, MetalsClassLedger>();
  const metalUnknown = emptyUnknown();
  const metalOf = (metal: Metal) => {
    let entry = metals.get(metal);
    if (!entry) metals.set(metal, (entry = { classes: new Map(), unknown: emptyUnknown() }));
    return entry;
  };
  const ledgerOf = (metal: Metal, form: MetalsClassForm, fine: Rational) => {
    const key = classKey(metal, form, fine);
    let ledger = ledgers.get(key);
    if (!ledger) {
      ledger = {
        key, metal, form, fineTroyOzPerUnit: fine,
        units: { delivered: 0, awaiting: 0, sold: 0, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0 },
        cents: { saleNets: 0, cycleNets: 0, unmatchedNets: 0, lotCosts: 0, assignedCosts: 0, heldCosts: 0, awaitingUnassignedCosts: 0, cancelledOrReturnedCosts: 0 },
        heldCostIncompleteLots: [],
        dateUnknownLots: [],
      };
      ledgers.set(key, ledger);
      metalOf(metal).classes.set(key, ledger);
    }
    return ledger;
  };

  const slotsByClass = new Map<string, LotSlot[]>();
  for (const lot of lots) {
    if (lot.orderDate > asOf) continue;
    if (lot.metal === null || lot.fineTroyOzPerUnit === null) {
      const bucket = lot.metal === null ? metalUnknown : metalOf(lot.metal).unknown;
      bucket.lots.push(lot.key);
      bucket.lotCostMinor += lot.costMinor;
      continue;
    }
    const { delivered, awaiting, returned, cancelled, ordered } = lot.units;
    const states: UnitState[] = [
      ...Array<UnitState>(delivered).fill('delivered'), ...Array<UnitState>(awaiting).fill('awaiting'),
      ...Array<UnitState>(returned).fill('returned'), ...Array<UnitState>(cancelled).fill('cancelled'),
    ];
    if (states.length !== ordered) throw new RangeError(`metalsAssignment: lot ${lot.key} units do not add up`);
    const ledger = ledgerOf(lot.metal, metalsAssignmentClassForm(lot.metal, lot.form, policy), lot.fineTroyOzPerUnit);
    ledger.units.delivered += delivered;
    ledger.units.awaiting += awaiting;
    ledger.cents.lotCosts += lot.costMinor;
    const slot: LotSlot = {
      lot,
      position: 0,
      unitCosts: metalsUnitSplit(lot.costMinor, ordered),
      states,
      assignable: states.flatMap((state, index) => (state === 'delivered' || state === 'awaiting' ? [index] : [])),
      next: 0,
      assignedTo: states.map(() => null),
    };
    const list = slotsByClass.get(ledger.key) ?? [];
    list.push(slot);
    slotsByClass.set(ledger.key, list);
  }
  for (const list of slotsByClass.values()) {
    list.sort((a, b) => compareText(a.lot.orderDate, b.lot.orderDate) || compareText(a.lot.orderKey, b.lot.orderKey)
      || a.lot.ordinal - b.lot.ordinal);
    list.forEach((slot, position) => {
      slot.position = position;
    });
  }

  const ordered = sales
    .filter((sale) => !sale.cancelled && sale.agreedDay <= asOf)
    .sort((a, b) => (Date.parse(a.tradeMoment) - Date.parse(b.tradeMoment)) || compareText(a.orderKey, b.orderKey)
      || a.ordinal - b.ordinal || compareText(a.key, b.key));

  const cycles = new Map<string, MetalsCycle>();
  const saleLines: MetalsSaleLine[] = [];
  /** Per classed sale line: its class and the latest place in its class's order it took a unit from (−1: none). */
  const reach = new Map<MetalsSaleLine, { classKey: string; latest: number }>();
  for (const sale of ordered) {
    const nets = metalsUnitSplit(sale.netMinor, sale.quantity);
    const contentKnown = sale.metal !== null && sale.fineTroyOzPerUnit !== null;
    const line: MetalsSaleLine = {
      key: sale.key, agreedDay: sale.agreedDay, metal: sale.metal, contentKnown, units: sale.quantity,
      fineTroyOz: contentKnown ? multiply(sale.fineTroyOzPerUnit!, rational(BigInt(sale.quantity))) : null,
      matchedUnits: 0, unmatchedUnits: 0, matchedNetMinor: 0, unmatchedNetMinor: 0, known: false, costIncomplete: false,
      dateUnknownLots: [],
    };
    saleLines.push(line);
    if (!contentKnown) {
      const bucket = sale.metal === null ? metalUnknown : metalOf(sale.metal).unknown;
      bucket.sales.push(sale.key);
      bucket.saleNetMinor += sale.netMinor;
      continue;
    }
    const ledger = ledgerOf(sale.metal!, metalsAssignmentClassForm(sale.metal!, sale.form, policy), sale.fineTroyOzPerUnit!);
    const slots = slotsByClass.get(ledger.key) ?? [];
    const reached = { classKey: ledger.key, latest: -1 };
    reach.set(line, reached);
    for (let unit = 0; unit < sale.quantity; unit += 1) {
      ledger.units.sold += 1;
      ledger.cents.saleNets += nets[unit];
      const slot = slots.find((candidate) => candidate.lot.orderDate <= sale.agreedDay && candidate.next < candidate.assignable.length);
      if (!slot) {
        ledger.units.unmatched += 1;
        ledger.cents.unmatchedNets += nets[unit];
        line.unmatchedUnits += 1;
        line.unmatchedNetMinor += nets[unit];
        continue;
      }
      const lotUnit = slot.assignable[slot.next];
      slot.next += 1;
      slot.assignedTo[lotUnit] = sale.key;
      reached.latest = Math.max(reached.latest, slot.position);
      if (slot.states[lotUnit] === 'delivered') ledger.units.soldFromDelivered += 1;
      else ledger.units.soldFromAwaiting += 1;
      ledger.cents.cycleNets += nets[unit];
      line.matchedUnits += 1;
      line.matchedNetMinor += nets[unit];
      if (!slot.lot.costComplete) line.costIncomplete = true;
      const key = `${slot.lot.key}\u0000${sale.key}`;
      const cycle = cycles.get(key) ?? {
        lotKey: slot.lot.key, saleKey: sale.key, units: 0, fineTroyOz: ZERO, costMinor: 0, proceedsMinor: 0,
        costComplete: slot.lot.costComplete, profitMinor: null, orderDate: slot.lot.orderDate, agreedDay: sale.agreedDay,
        daysHeld: daysBetween(slot.lot.orderDate, sale.agreedDay),
      };
      cycle.units += 1;
      cycle.fineTroyOz = add(cycle.fineTroyOz, sale.fineTroyOzPerUnit!);
      cycle.costMinor += slot.unitCosts[lotUnit];
      cycle.proceedsMinor += nets[unit];
      cycles.set(key, cycle);
    }
    line.known = line.unmatchedUnits === 0 && !line.costIncomplete;
  }
  for (const cycle of cycles.values()) cycle.profitMinor = cycle.costComplete ? cycle.proceedsMinor - cycle.costMinor : null;

  // Date uncertainty. A lot's uncertain cancellation or return can move units in or out of assignment at its place in
  // the class's order. Lots before it are taken first by every sale that may take it, so a sale served entirely by
  // earlier lots keeps its purchases either way; a sale that took from it or a later lot, or found none, may not.
  for (const [line, { classKey: key, latest }] of reach) {
    for (const slot of slotsByClass.get(key) ?? []) {
      if (!slot.lot.units.assignableDateUnknown || slot.lot.orderDate > line.agreedDay) continue;
      if (line.unmatchedUnits > 0 || latest >= slot.position) line.dateUnknownLots.push(slot.lot.key);
    }
  }

  for (const [key, slots] of slotsByClass) {
    const ledger = ledgers.get(key)!;
    for (const slot of slots) {
      let heldHere = 0;
      slot.states.forEach((state, index) => {
        const cost = slot.unitCosts[index];
        if (slot.assignedTo[index] !== null) ledger.cents.assignedCosts += cost;
        else if (state === 'delivered') {
          ledger.cents.heldCosts += cost;
          heldHere += 1;
        } else if (state === 'awaiting') ledger.cents.awaitingUnassignedCosts += cost;
        else ledger.cents.cancelledOrReturnedCosts += cost;
      });
      if (heldHere > 0 && !slot.lot.costComplete) ledger.heldCostIncompleteLots.push(slot.lot.key);
      if (slot.lot.units.dateUnknown) ledger.dateUnknownLots.push(slot.lot.key);
    }
  }
  for (const ledger of ledgers.values()) {
    ledger.units.held = ledger.units.delivered - ledger.units.soldFromDelivered;
    ledger.units.awaitingUnassigned = ledger.units.awaiting - ledger.units.soldFromAwaiting;
    // Delivery inferred (fungible classes only): units sold from awaiting read delivered; H and A − S_A stay as computed.
    if (ledger.form === 'any') {
      const inferred = ledger.units.soldFromAwaiting;
      ledger.units.delivered += inferred;
      ledger.units.soldFromDelivered += inferred;
      ledger.units.awaiting -= inferred;
      ledger.units.soldFromAwaiting = 0;
      ledger.deliveryInferred = inferred;
    }
  }

  return {
    asOf,
    metals: [...metals.entries()].sort(([a], [b]) => compareText(a, b)).map(([metal, entry]) => ({
      metal,
      classes: [...entry.classes.values()].sort((a, b) => compareText(a.key, b.key)),
      contentUnknown: entry.unknown,
    })),
    metalUnknown,
    cycles: [...cycles.values()],
    sales: saleLines,
  };
}

export interface MetalsProfitCoverage {
  basis: 'troy-oz' | 'sale-lines';
  /**
   * What the profit sums: troy ounces in cycles with complete cost, as "n/d" (basis troy-oz), or a count of known sale
   * lines, every unit matched with complete cost (basis sale-lines).
   */
  known: string;
  total: string;
  unknownContentLines: number;
}

/**
 * Profit or loss on sales agreed in [from, to] for one metal, with its coverage; the value and the coverage's `known`
 * describe the same set. In troy ounces when every sale line in the period has known content: the sum over cycles with
 * complete cost. Otherwise in sale lines (lines of unknown content always counted in the total): the sum over the
 * cycles of known lines only. Unmatched units, unknown content, incomplete costs and date-uncertain purchases
 * (`date-unknown`, counted per sale line) make it partial; with nothing known it is unknown, never zero.
 */
export function metalsProfitOnSales(
  assignment: MetalsAssignment,
  metal: Metal,
  from: string,
  to: string,
): { profit: MetalsMeasure<number>; coverage: MetalsProfitCoverage } {
  const lines = assignment.sales.filter((line) => line.metal === metal && line.agreedDay >= from && line.agreedDay <= to);
  const keys = new Set(lines.map((line) => line.key));
  const cycles = assignment.cycles.filter((cycle) => keys.has(cycle.saleKey));
  const reasons = new MetalsReasons();
  for (const line of lines) {
    if (!line.contentKnown) reasons.add('content-unknown', line.key);
    if (line.unmatchedUnits > 0) reasons.add('unmatched-sales', line.key);
    if (line.costIncomplete) reasons.add('cost-unattributed', line.key);
    if (line.dateUnknownLots.length > 0) reasons.add('date-unknown', line.key);
  }
  const complete = cycles.filter((cycle) => cycle.costComplete);
  const unknownContentLines = lines.filter((line) => !line.contentKnown).length;
  const knownLines = new Set(lines.filter((line) => line.known).map((line) => line.key));
  const counted = unknownContentLines === 0 ? complete : complete.filter((cycle) => knownLines.has(cycle.saleKey));
  const coverage: MetalsProfitCoverage = unknownContentLines === 0
    ? {
      basis: 'troy-oz',
      known: formatRational(counted.reduce((total, cycle) => add(total, cycle.fineTroyOz), ZERO)),
      total: formatRational(lines.reduce((total, line) => add(total, line.fineTroyOz!), ZERO)),
      unknownContentLines,
    }
    : { basis: 'sale-lines', known: String(knownLines.size), total: String(lines.length), unknownContentLines };
  if (lines.length === 0) return { profit: metalsMeasure(0), coverage };
  const value = counted.length === 0 ? null : counted.reduce((total, cycle) => total + cycle.profitMinor!, 0);
  return { profit: metalsMeasure(value, reasons), coverage };
}
