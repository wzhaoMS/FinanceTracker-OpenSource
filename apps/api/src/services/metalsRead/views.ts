/**
 * The metals ledger's views (design v8 §8–§10, G3): the answers of `/metals/*`, built from the per-data-version graph
 * (ledger.ts), the day in New York and each metal's admissible closes. Holdings are replayed as of a date (§4.3);
 * activity is over a period on its named date basis (bought by order date, sold and profit or loss by agreed day,
 * payouts by payout date) with everything known today. Every measure carries its completeness; unknown is never zero.
 *
 * Completeness, as these views apply the codes:
 * - `content-unknown`: lots or sales of the metal whose fine content is held (in no class, counted once at the metal);
 * - `unmatched-sales`: sale lines with units no recorded purchase was assigned to;
 * - `cost-estimated`: under the owner's estimate switch, sale lines whose units with no recorded purchase take an
 *   estimated cost (in place of `unmatched-sales` on that sale's cost basis and profit or loss, and the period's);
 * - `cost-unattributed`: lots whose cost an unattributed order component could have reached (a lot's merchandise: only
 *   an unattributed order-level discount);
 * - `conflict`: orders a later capture contradicts (quarantined), fail-closed (Root's ruling): the read side never reads
 *   the contradicting version, which could move an order's date, quantities, money or content anywhere, so every
 *   figure of the metal that an order of its side can change carries every quarantined order of the metal (or with a
 *   line of unknown metal), whatever its date or class: holdings, classes, source rows, each sale and profit or loss
 *   (either side), bought (purchases), sold and payouts (sales);
 * - `date-unknown`: lots with an undated or year-inferred event, and sale lines whose purchases a date-uncertain
 *   cancellation or return could change (G1d); a lot's merchandise only while how many of its units are kept is uncertain;
 * - `source-held`: held records still open, dated in the figure's window or undated, and the orders held for metals on
 *   the metal's page dated in it (G3-int A0: counted with the held records, the order key as the record; see
 *   `heldOrdersOn`);
 * - `not-covered`: a source account and kind whose complete imports don't span the figure's days (a holding: from the
 *   account's first covered day to the as-of day; activity: the whole period). Days after an account's last covered day
 *   count: unknown coverage is never assumed, as Spending's coverage rule;
 * - `price-missing` and `price-stale`: values at spot without an admissible close, or with one older than 5 weekdays;
 *   never on a holding that proves it holds nothing, which is valued at 0 (`provesNothingHeld`: zero ounces need no price).
 *
 * Sub-figures carry their own share, never less than what could change them: a class its lots' date-unknown and its
 * unmatched sales, the metal's quarantined orders and content-unknown lots and sales (confirming content can add a lot
 * to it, or a sale that takes its earliest unit) and the ledger-wide source-held and not-covered. The assignment is one
 * first-in, first-out queue per class across every account, so a source account inherits the full reasons of every
 * class it holds or held a lot in, beside its own lots' reasons. Sold money carries the sell side's gaps in the period;
 * payouts theirs, with every open held sell record dated on or before the period's end, and sell coverage from the earlier
 * of the period's start and the first covered day. Profit or loss carries every reason of each of its sales
 * (`saleReasons`): their own, the unconfirmed content first-in, first-out could reach before them, the quarantined orders,
 * and the held records and gaps of either side up to their days.
 *
 * The owner's assignment policy (`fungible`, `HOLDR_METALS_FUNGIBLE`; contract `MetalsAssignmentMethod`): a metal it names
 * is assigned oldest first across forms (G1d's `metalsAssignment` with the policy, and `inClass` by the same class form,
 * `metalsAssignmentClassForm`), and a unit a sale took from awaiting reads delivered as of the sale's agreed day, in its
 * class's units and in its source row's units on the way. The overview, purchases, sales and timeline then carry
 * `assignment`. A purchase's own `units` and `delivery` stay as captured. With no policy every answer is
 * metals-assignment-v1's, byte for byte.
 *
 * The owner's estimate switch (`estimateUnmatched`, `HOLDR_METALS_ESTIMATE_UNMATCHED`; contract
 * `MetalsCostEstimateMethod`): each unit of a sale line of a metal it names with no recorded purchase takes a cost
 * estimated from the nearest purchase of its class (G1d's assignment read by `metalsUnmatchedEstimates`, with the class
 * form the assignment used). A label, never a fact: the assignment, holdings (classes and source rows, whose reasons keep
 * `unmatched-sales`), purchases, bought, sold, payouts, the timeline and every preview are as without it. Only a sale's
 * cost basis and profit or loss (`sales`) and the period's (`activity`) include it, with `cost-estimated` in place of
 * `unmatched-sales` for that sale and their recorded and estimated parts said apart, and each class of the metal says
 * its units with and without an estimate. The overview and sales then carry `costEstimate`. With no metal named every
 * answer is as before, byte for byte.
 *
 * Pure: no file system, network or clock.
 */

import {
  METALS,
  METALS_ASSIGNMENT_FUNGIBLE_RULE,
  METALS_ESTIMATE_RULE,
  METALS_SOURCES,
  MetalsReasons,
  add,
  divide,
  equals,
  formatRational,
  metalsAssignment,
  metalsAssignmentClassForm,
  metalsCloseOnOrBefore,
  metalsCycleBySpot,
  metalsLotUnitsAsOf,
  metalsMeasure,
  metalsMerchandise,
  metalsMerchantClass,
  metalsPriceStale,
  metalsProfitOnSales,
  metalsProfitOnSalesWithEstimates,
  metalsRangeCoverage,
  metalsReceiptCharges,
  metalsUnitSplit,
  metalsUnmatchedEstimates,
  metalsValueParts,
  multiply,
  parseRational,
  rational,
  readRational,
  subtract,
  toDecimal,
  troyOunces,
  ZERO,
  type Metal,
  type MetalsAdmissibleClose,
  type MetalsAssignment,
  type MetalsAssignmentLot,
  type MetalsAssignmentPolicy,
  type MetalsAssignmentSale,
  type MetalsClassLedger,
  type MetalsCoverageKind,
  type MetalsEstimateLine,
  type MetalsEstimates,
  type MetalsEvent,
  type MetalsLotUnits,
  type MetalsMeasure,
  type MetalsOrder,
  type MetalsPayout,
  type MetalsSaleLine,
  type MetalsSkeletonLine,
  type MetalsSource,
  type Rational,
} from '@finance-tracker/shared/metals-ledger';
import { CARD_METALS_MERCHANT_CLASSES } from '@finance-tracker/shared';
import type {
  MetalsAccountRef,
  MetalsAnswerLine,
  MetalsAnswers,
  MetalsAssignmentMethod,
  MetalsBullionDecision,
  MetalsClassUnits,
  MetalsCloses,
  MetalsContent,
  MetalsCostEstimateMethod,
  MetalsCoverageEntry,
  MetalsDeliveryState,
  MetalsForInformation,
  MetalsFunding,
  MetalsFundingPurchase,
  MetalsHoldingClass,
  MetalsHoldingSource,
  MetalsLinkedAccount,
  MetalsNeedsAnswer,
  MetalsNeedsYou,
  MetalsOverview,
  MetalsPriceUsed,
  MetalsProduct,
  MetalsProducts,
  MetalsProfitCoverage,
  MetalsProfitEstimate,
  MetalsPurchase,
  MetalsPurchaseCard,
  MetalsPurchases,
  MetalsSale,
  MetalsSaleCycle,
  MetalsSaleEstimate,
  MetalsSalePayout,
  MetalsSales,
  MetalsSaleSpot,
  MetalsTimeline,
  MetalsTimelineMonth,
  MetalsTroyOz,
  MetalsUnmatchedPart,
  MetalsUnmatchedReason,
} from '@finance-tracker/shared/metals-api';
import { METALS_UNMATCHED_REASONS } from '@finance-tracker/shared/metals-api';

import type { MetalsCloseScreenV2 } from './closeScreen.js';
import type {
  MetalsBullionDecisionInput,
  MetalsDecisionInput,
  MetalsFlaggedLine,
  MetalsLedgerGraph,
  MetalsLedgerLine,
  MetalsLedgerOrder,
} from './ledger.js';
import { metalsDealerSpot, type MetalsDealerSpot } from './premiumText.js';

/** Sold units with no recorded purchase, summed per reason across sale lines, in METALS_UNMATCHED_REASONS order. */
function mergeUnmatched(parts: Iterable<MetalsUnmatchedPart>): MetalsUnmatchedPart[] {
  const totals = new Map<MetalsUnmatchedReason, MetalsUnmatchedPart>();
  for (const part of parts) {
    const total = totals.get(part.reason) ?? { reason: part.reason, units: 0, netMinor: 0 };
    total.units += part.units;
    total.netMinor += part.netMinor;
    totals.set(part.reason, total);
  }
  return METALS_UNMATCHED_REASONS.flatMap((reason) => totals.get(reason) ?? []);
}

export const METALS_PRICE_SOURCE_LABEL = 'cnbc-spot-daily' as const;
const EARLIEST = '0000-01-01';
const BUY_SOURCES: readonly MetalsSource[] = ['costco', 'walmart'];
const SELL_SOURCES: readonly MetalsSource[] = ['collectpure'];
/** The coverage kinds each source states (§5): a source account is covered for a figure only through all of them. */
const KINDS: Readonly<Record<MetalsSource, readonly MetalsCoverageKind[]>> = {
  costco: ['online', 'warehouse'],
  walmart: ['online'],
  collectpure: ['sell-orders', 'payouts'],
};

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const within = (date: string, from: string | null, to: string) => date >= (from ?? EARLIEST) && date <= to;
/** The earlier of two days, either of which may be unknown (null). */
const earlierDay = (a: string | null, b: string | null): string | null => (a === null ? b : b === null || a < b ? a : b);
/** The kinds a holding's coverage is judged on: a payout never changes what is held. */
const HOLDING_KINDS = (source: MetalsSource) => KINDS[source].filter((kind) => kind !== 'payouts');
const holdRecord = (hold: { importId: string; seq: number }) => `${hold.importId}#${hold.seq}`;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Troy ounces as the API sends them: the exact rational and three decimals, half to even. */
export function metalsTroyOz(value: Rational): MetalsTroyOz {
  return { exact: formatRational(value), display: toDecimal(value, 3).text };
}

/** A close as decimal dollars ("2650.4"), at most six decimals, trailing zeros dropped. */
function plainDecimal(value: Rational): string {
  const text = toDecimal(value, 6).text;
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

const timesUnits = (fine: Rational, units: number) => multiply(fine, rational(BigInt(units)));
const sumOz = (values: Iterable<Rational>) => {
  let total = ZERO;
  for (const value of values) total = add(total, value);
  return total;
};

interface Range {
  from: string;
  to: string;
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= addDays(last.to, 1)) {
      if (range.to > last.to) last.to = range.to;
    } else merged.push({ ...range });
  }
  return merged;
}

/** A measure over a value that is unknown when nothing is known at all, else the known part with its reasons. */
function partialSum<T>(value: T, anyKnown: boolean, anyUnknown: boolean, reasons: MetalsReasons): MetalsMeasure<T> {
  return metalsMeasure(!anyKnown && anyUnknown ? null : value, reasons);
}

/**
 * Held ounces (§4.4.3, §11): a zero that anything missing could change is unknown, never a partial zero that reads as
 * none held (the Gold lead's ruling: unknown wins over a partial zero). That covers none known too, since a lot of unknown
 * content always carries its reason. A known part still gives a partial sum, and nothing missing gives a true zero. Every
 * figure built on the ounces (cost, value, gain, awaiting) is unknown while they are.
 */
function heldTroyOz(oz: Rational, reasons: MetalsReasons): MetalsMeasure<MetalsTroyOz> {
  return metalsMeasure(oz.num === 0n && reasons.size > 0 ? null : metalsTroyOz(oz), reasons);
}

/**
 * Whether a holding (the metal's, a class's or a source row's) proves it holds nothing (the Gold lead's ruling): no unit
 * held or awaiting, its ounces known (so a true zero: `heldTroyOz` leaves a zero unknown while any reason says something
 * is missing, a lot of unknown content first), no lot of unknown content kept, and no lot of unknown metal kept anywhere
 * in the ledger, held or awaiting (the lead's condition: any of them could be this metal). Zero ounces need no price:
 * its value and gain at spot are exactly 0 and known, with no price reason, whether a close is stored or not; its other
 * reasons stay.
 */
function provesNothingHeld(troyOz: MetalsMeasure<MetalsTroyOz>, units: { held: number; awaiting: number }, metalUnknownKept: number,
  contentUnknownKept = 0): boolean {
  return troyOz.value !== null && units.held === 0 && units.awaiting === 0 && contentUnknownKept === 0 && metalUnknownKept === 0;
}

function unionReasons(...lists: MetalsReasons[]): MetalsReasons {
  const reasons = new MetalsReasons();
  for (const list of lists) reasons.addAll(list);
  return reasons;
}

const lastEventDate = (events: readonly MetalsEvent[], kind: MetalsEvent['kind']): string | null =>
  events.filter((event) => event.kind === kind && event.date !== null).map((event) => event.date!).sort(compareText).pop() ?? null;

/** Every principal line (item or fuel) is metal, as G1d's receipt-charge rule reads an all-metal order. */
function allMetalOrder(skeleton: readonly MetalsSkeletonLine[]): boolean {
  const principals = skeleton.filter((line) => line.kind === 'item' || line.kind === 'fuel');
  return principals.length > 0 && principals.every((line) => line.metal);
}

/**
 * The metals an order's lines name, as the page scope of an order held for metals reads them: a flagged line the metal
 * its flag names, any other line its own; null when one is unknown (a flag naming several metals, a line of unknown
 * metal, or a flag that can't be read).
 */
export function metalsHeldOrderMetals(order: MetalsOrder): Array<Metal | null> {
  return order.lines.map((line) => (line.metalUncertain === null ? line.metal : (line.metalUncertain?.metal ?? null)));
}

/** Recorded-holdings position of one lot within an assignment: its units assigned, held, and the cost of those held. */
interface LotPosition {
  assigned: number;
  held: number;
  heldCostMinor: number;
}

export interface MetalsViewOptions {
  graph: MetalsLedgerGraph;
  /** Today's date in New York. */
  today: string;
  /**
   * A metal's closes as valuation screens them as of today: admissible closes oldest first, level shifts. The routes give
   * the stored closes' screen (metalsScreenClosesV2) while this Holdr fetches, and none while it doesn't (ROOT O110);
   * `/metals/closes` takes the stored closes' screen either way.
   */
  screen: (metal: Metal) => Pick<MetalsCloseScreenV2, 'admissible' | 'levelShifts'>;
  /** Whether this Holdr fetches closes (HOLDR_METALS_PRICES=1). */
  fetching: boolean;
  /**
   * The owner's assignment policy (`HOLDR_METALS_FUNGIBLE`, contract `MetalsAssignmentMethod`): the metals assigned oldest
   * first across forms, where a unit a sale took from awaiting reads delivered. None (the default): metals-assignment-v1,
   * and every answer is as it was byte for byte.
   */
  fungible?: readonly Metal[];
  /**
   * The owner's estimate switch (`HOLDR_METALS_ESTIMATE_UNMATCHED`, contract `MetalsCostEstimateMethod`): the metals whose
   * sold units with no recorded purchase take a cost estimated from the nearest purchase of their class. None (the
   * default): nothing is estimated, and every answer is as it was byte for byte.
   */
  estimateUnmatched?: readonly Metal[];
}

/** How long after its admission a level shift is still shown beside the price (D-G3-1, guard 2). */
export const METALS_LEVEL_SHIFT_SHOWN_DAYS = 30;

const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * One request's views over one graph. Assignments are memoized per as-of day: the one as of today serves activity,
 * profit or loss, the lists and the previews; holdings and the timeline replay their own days.
 */
export class MetalsViews {
  readonly graph: MetalsLedgerGraph;
  readonly today: string;
  private readonly assignments = new Map<string, MetalsAssignment>();
  private readonly ledgerWideCache = new Map<string, MetalsReasons>();
  private readonly historyStarts = new Map<string, string | null>();
  private readonly screens = new Map<Metal, Pick<MetalsCloseScreenV2, 'admissible' | 'levelShifts'>>();
  /** Coverage stated by an import this read knows (H7): what an unknown import states never covers anything. */
  private readonly knownCoverage: MetalsLedgerGraph['coverage'];
  /** The owner's fungible policy, its metals in METALS order (none: metals-assignment-v1). */
  private readonly policy: MetalsAssignmentPolicy;
  /** The owner's estimate switch, its metals in METALS order (none: nothing is estimated). */
  private readonly estimateMetals: Metal[];
  /** Each memoized assignment's lots and sales, which its estimates read. */
  private readonly assignmentInputs = new Map<string, { lots: MetalsAssignmentLot[]; sales: MetalsAssignmentSale[] }>();
  private readonly estimateMemo = new Map<string, { estimates: MetalsEstimates; bySale: Map<string, MetalsEstimateLine> }>();

  constructor(private readonly options: MetalsViewOptions, private readonly fineOverrides?: ReadonlyMap<string, Rational | null>) {
    this.graph = options.graph;
    this.today = options.today;
    const imports = new Set(options.graph.imports.map((entry) => entry.importId));
    this.knownCoverage = options.graph.coverage.filter((entry) => imports.has(entry.importId));
    this.policy = { fungible: METALS.filter((metal) => (options.fungible ?? []).includes(metal)) };
    this.estimateMetals = METALS.filter((metal) => (options.estimateUnmatched ?? []).includes(metal));
  }

  /** The same views with some lines' fine content replaced (a preview of an owner decision). */
  withFine(overrides: ReadonlyMap<string, Rational | null>): MetalsViews {
    return new MetalsViews(this.options, overrides);
  }

  fineOf(entry: MetalsLedgerLine): Rational | null {
    return this.fineOverrides?.has(entry.key) ? this.fineOverrides.get(entry.key)! : entry.fine;
  }

  /**
   * The owner's fungible policy on the reads it changes (overview, purchases, sales, timeline): `{ assignment }` while it
   * names a metal, and nothing otherwise, so those reads stay byte for byte metals-assignment-v1's.
   */
  private method(): { assignment?: MetalsAssignmentMethod } {
    return this.policy.fungible.length === 0 ? {}
      : { assignment: { rule: METALS_ASSIGNMENT_FUNGIBLE_RULE, fungible: [...this.policy.fungible] } };
  }

  /**
   * The owner's estimate switch on the reads it changes (overview, sales): `{ costEstimate }` while it names a metal, and
   * nothing otherwise, so those reads stay byte for byte as they were.
   */
  private estimateMethod(): { costEstimate?: MetalsCostEstimateMethod } {
    return this.estimateMetals.length === 0 ? {} : { costEstimate: { rule: METALS_ESTIMATE_RULE, metals: [...this.estimateMetals] } };
  }

  // -------------------------------------------------------------------------
  // Shared readings
  // -------------------------------------------------------------------------

  private screen(metal: Metal): Pick<MetalsCloseScreenV2, 'admissible' | 'levelShifts'> {
    let screen = this.screens.get(metal);
    if (!screen) this.screens.set(metal, (screen = this.options.screen(metal)));
    return screen;
  }

  closes(metal: Metal): readonly MetalsAdmissibleClose[] {
    return this.screen(metal).admissible;
  }

  closeOn(metal: Metal, date: string): MetalsAdmissibleClose | null {
    return metalsCloseOnOrBefore(this.closes(metal), date);
  }

  /** The level shift to show beside a price valued on `date`: one still refused then, or admitted within 30 days. */
  levelShift(metal: Metal, date: string): MetalsPriceUsed['levelShift'] {
    const shift = this.screen(metal).levelShifts.filter((entry) => entry.movedOn <= date).pop();
    if (!shift) return null;
    if (shift.admittedOn === null || shift.admittedOn > date) return { movedOn: shift.movedOn, admittedOn: null, days: daysFrom(shift.movedOn, date) };
    return daysFrom(shift.admittedOn, date) <= METALS_LEVEL_SHIFT_SHOWN_DAYS
      ? { movedOn: shift.movedOn, admittedOn: shift.admittedOn, days: daysFrom(shift.movedOn, shift.admittedOn) }
      : null;
  }

  priceUsed(metal: Metal, date: string): MetalsPriceUsed {
    const close = this.closeOn(metal, date);
    return {
      source: METALS_PRICE_SOURCE_LABEL,
      closeDate: close?.date ?? null,
      close: close ? plainDecimal(close.close) : null,
      stale: close !== null && metalsPriceStale(close.date, date),
      thinHistory: close?.thinHistory ?? false,
      levelShift: this.levelShift(metal, date),
      fetching: this.options.fetching,
    };
  }

  private priceReasons(metal: Metal, date: string): MetalsReasons {
    const reasons = new MetalsReasons();
    const close = this.closeOn(metal, date);
    if (close === null) reasons.add('price-missing', metal);
    else if (metalsPriceStale(close.date, date)) reasons.add('price-stale', metal);
    return reasons;
  }

  lines(metal: Metal, side: 'buy' | 'sell'): MetalsLedgerLine[] {
    return this.graph.lines.filter((entry) => entry.side === side && entry.line.metal === metal);
  }

  unitsAsOf(entry: MetalsLedgerLine, asOf: string): MetalsLotUnits | null {
    return metalsLotUnitsAsOf({ orderDate: entry.order.order.date, quantity: entry.line.quantity, events: entry.line.events }, asOf);
  }

  assignment(asOf: string): MetalsAssignment {
    let assignment = this.assignments.get(asOf);
    if (assignment) return assignment;
    const lots: MetalsAssignmentLot[] = [];
    const sales: MetalsAssignmentSale[] = [];
    for (const entry of this.graph.lines) {
      if (entry.side === 'buy') {
        const units = this.unitsAsOf(entry, asOf);
        if (!units) continue;
        lots.push({
          key: entry.key, orderKey: entry.order.order.key, orderDate: entry.order.order.date, ordinal: entry.line.ordinal,
          metal: entry.line.metal, form: entry.line.form, fineTroyOzPerUnit: this.fineOf(entry), units,
          costMinor: entry.line.costMinor ?? 0, costComplete: entry.line.complete,
        });
      } else {
        sales.push({
          key: entry.key, orderKey: entry.order.order.key, tradeMoment: entry.order.order.tradeMoment ?? `${entry.order.order.date}T12:00:00Z`,
          agreedDay: entry.order.order.date, ordinal: entry.line.ordinal, metal: entry.line.metal, form: entry.line.form,
          fineTroyOzPerUnit: this.fineOf(entry), quantity: entry.line.quantity, netMinor: entry.line.netMinor ?? 0,
          cancelled: entry.order.order.status === 'cancelled',
        });
      }
    }
    assignment = metalsAssignment(lots, sales, asOf, this.policy);
    this.assignments.set(asOf, assignment);
    this.assignmentInputs.set(asOf, { lots, sales });
    return assignment;
  }

  /**
   * The estimates over the assignment as of a day, while the owner's estimate switch names a metal (null otherwise): from
   * the lots and sales that assignment read, in the classes it assigned (its class form, the fungible policy's included).
   */
  private estimates(asOf: string): { estimates: MetalsEstimates; bySale: Map<string, MetalsEstimateLine> } | null {
    if (this.estimateMetals.length === 0) return null;
    let memo = this.estimateMemo.get(asOf);
    if (!memo) {
      const assignment = this.assignment(asOf);
      const estimates = metalsUnmatchedEstimates(assignment, this.assignmentInputs.get(asOf)!, this.estimateMetals,
        (metal, form) => metalsAssignmentClassForm(metal, form, this.policy));
      memo = { estimates, bySale: new Map(estimates.lines.map((line) => [line.saleKey, line])) };
      this.estimateMemo.set(asOf, memo);
    }
    return memo;
  }

  /** Whether the owner's estimate switch names the metal. */
  private estimatesCostOf(metal: Metal): boolean {
    return this.estimateMetals.includes(metal);
  }

  /** A sale line's estimate in an assignment, when the switch names its metal and its class gives one. */
  private estimateOf(line: MetalsSaleLine, assignment: MetalsAssignment): MetalsEstimateLine | undefined {
    return this.estimates(assignment.asOf)?.bySale.get(line.key);
  }

  /** A class's units with no recorded purchase as of a day, with an estimate and without (zeros when it has none). */
  private classEstimate(classKey: string, asOf: string): NonNullable<MetalsHoldingClass['estimate']> {
    const entry = this.estimates(asOf)?.estimates.classes.find((candidate) => candidate.classKey === classKey);
    return { units: entry?.units ?? 0, costMinor: entry?.costMinor ?? 0, unestimatedUnits: entry?.unestimatedUnits ?? 0 };
  }

  /**
   * Why a sale line's units have no recorded purchase today (§4.3). A line's matched units are the first of its units,
   * and the assignment as of its agreed day matches at least as many as today's: those it matched and today's doesn't
   * lost their purchase to a cancellation or return since (a later leave never rewrites that day, so holdings as of it
   * stay as they were); the rest had none on that day.
   */
  unmatchedParts(saleKey: string): MetalsUnmatchedPart[] {
    const now = this.assignment(this.today).sales.find((line) => line.key === saleKey);
    if (!now || now.unmatchedUnits === 0) return [];
    const then = this.assignment(now.agreedDay).sales.find((line) => line.key === saleKey);
    const matchedThen = Math.min(now.units, Math.max(now.matchedUnits, then?.matchedUnits ?? 0));
    const nets = metalsUnitSplit(this.graph.lineByKey.get(saleKey)?.line.netMinor ?? 0, now.units);
    const sum = (from: number, to: number) => nets.slice(from, to).reduce((total, net) => total + net, 0);
    const parts: Record<MetalsUnmatchedReason, MetalsUnmatchedPart> = {
      'no-recorded-purchase': { reason: 'no-recorded-purchase', units: now.units - matchedThen, netMinor: sum(matchedThen, now.units) },
      'purchase-cancelled-or-returned': {
        reason: 'purchase-cancelled-or-returned', units: matchedThen - now.matchedUnits, netMinor: sum(now.matchedUnits, matchedThen),
      },
    };
    return METALS_UNMATCHED_REASONS.map((reason) => parts[reason]).filter((part) => part.units > 0);
  }

  /** Each content-known lot's position within an assignment: delivered units are assigned first (G1d's unit order). */
  lotPositions(assignment: MetalsAssignment): Map<string, LotPosition> {
    const assigned = new Map<string, number>();
    for (const cycle of assignment.cycles) assigned.set(cycle.lotKey, (assigned.get(cycle.lotKey) ?? 0) + cycle.units);
    const positions = new Map<string, LotPosition>();
    for (const entry of this.graph.lines) {
      if (entry.side !== 'buy' || entry.line.metal === null || this.fineOf(entry) === null) continue;
      const units = this.unitsAsOf(entry, assignment.asOf);
      if (!units) continue;
      const count = assigned.get(entry.key) ?? 0;
      const fromDelivered = Math.min(count, units.delivered);
      const costs = metalsUnitSplit(entry.line.costMinor ?? 0, units.ordered);
      positions.set(entry.key, {
        assigned: count,
        held: units.delivered - fromDelivered,
        heldCostMinor: costs.slice(fromDelivered, units.delivered).reduce((total, cost) => total + cost, 0),
      });
    }
    return positions;
  }

  /**
   * Source accounts and kinds whose complete imports don't span the days a figure needs, up to `to`. Only coverage an
   * import this read knows states counts (H7), and a kind never covered completely is never covered.
   * - A holding (no `from`) needs the account's known history: from the earlier of the kind's first complete covered day
   *   and the account's history start (`historyStartOf`: an incomplete range, an order or an open held record before the
   *   first complete range is its history too, H3).
   * - Activity (a `from`) needs the days from `from`, or with `earlierOfFirstCovered` from the earlier of `from` and the
   *   kind's first complete covered day (a payout can follow a sale agreed before its period). A window that ends before
   *   the kind's first complete covered day is never covered, though in all time its start (the side's first order) can
   *   fall after it (H1).
   * - The day arithmetic is G1d's `metalsRangeCoverage`, the one function behind these gaps and the coverage proof's
   *   (C5), over every complete range as a window: only the proof reads an entry's basis (`METALS_COVERAGE_BASIS`).
   */
  private coverageGaps(sources: readonly MetalsSource[], kinds: ((source: MetalsSource) => readonly MetalsCoverageKind[]), from: string | null, to: string,
    options: { accountId?: string; earlierOfFirstCovered?: boolean } = {}): string[] {
    const gaps: string[] = [];
    for (const account of this.graph.accounts.values()) {
      if (!sources.includes(account.source) || (options.accountId !== undefined && account.accountId !== options.accountId)) continue;
      for (const kind of kinds(account.source)) {
        const ranges = mergeRanges(this.knownCoverage
          .filter((entry) => entry.accountId === account.accountId && entry.kind === kind && entry.complete)
          .map((entry) => ({ from: entry.from, to: entry.to })));
        const first = ranges[0]?.from ?? null;
        const uncovered = first === null || (from !== null && to < first);
        const start = from === null ? earlierDay(first, this.historyStartOf(account.accountId))
          : options.earlierOfFirstCovered ? earlierDay(from, first) : from;
        if (uncovered || start === null || metalsRangeCoverage(ranges, { from: start, to }).missing.length > 0) gaps.push(`${account.accountId}|${kind}`);
      }
    }
    return gaps;
  }

  /**
   * The first day of an account's known history (H3): the earliest of the coverage it states (any kind, complete or not,
   * from any import), its orders and its open held records; null when it has none.
   */
  private historyStartOf(accountId: string): string | null {
    let start = this.historyStarts.get(accountId);
    if (start === undefined) {
      const days: string[] = [];
      for (const entry of this.graph.coverage) if (entry.accountId === accountId) days.push(entry.from);
      for (const order of this.graph.orders.values()) if (order.account.accountId === accountId) days.push(order.order.date);
      for (const hold of this.graph.openHolds) if (hold.accountId === accountId && hold.date !== null) days.push(hold.date);
      start = days.sort(compareText)[0] ?? null;
      this.historyStarts.set(accountId, start);
    }
    return start;
  }

  /**
   * The orders held for metals on a metal's page: a page lists a held order if and only if the order puts the held reason
   * on the page's figures, which it does for each flagged line's flag metal, each other line's own metal, and every
   * metal when one of them is unknown (`metalsHeldOrderMetals`). By order key.
   */
  heldOrdersOn(metal: Metal): MetalsLedgerOrder[] {
    return this.graph.heldOrders.filter((order) => metalsHeldOrderMetals(order.order).some((named) => named === metal || named === null));
  }

  /**
   * What a figure of the metal counts as held (`source-held`), dated in [from, to] or undated: the sources' open held
   * records (a held record names no metal), and the sources' orders held for metals on the metal's page, dated in it,
   * each its order key (G3-int A0: an order held for metals is counted with the held records).
   */
  private held(metal: Metal, sources: readonly MetalsSource[] | null, from: string | null, to: string): Array<{ record: string; accountId: string }> {
    const records = this.graph.openHolds.filter((hold) => (sources === null || sources.includes(hold.source))
      && (hold.date === null || within(hold.date, from, to))).map((hold) => ({ record: holdRecord(hold), accountId: hold.accountId }));
    const orders = this.heldOrdersOn(metal).filter((order) => (sources === null || sources.includes(order.source)) && within(order.order.date, from, to))
      .map((order) => ({ record: order.order.key, accountId: order.account.accountId }));
    return [...records, ...orders];
  }

  /** The reasons every holding figure of the metal as of `asOf` carries whatever its class: what is held, coverage gaps. */
  private ledgerWideHoldingReasons(metal: Metal, asOf: string): MetalsReasons {
    const cacheKey = `${metal}|${asOf}`;
    let reasons = this.ledgerWideCache.get(cacheKey);
    if (!reasons) {
      reasons = new MetalsReasons();
      for (const entry of this.held(metal, null, null, asOf)) reasons.add('source-held', entry.record);
      for (const gap of this.coverageGaps([...BUY_SOURCES, ...SELL_SOURCES], HOLDING_KINDS, null, asOf)) reasons.add('not-covered', gap);
      this.ledgerWideCache.set(cacheKey, reasons);
    }
    return unionReasons(reasons);
  }

  /** The reasons every holding figure as of `asOf` carries, apart from cost and price. */
  private holdingReasons(metal: Metal, asOf: string, assignment: MetalsAssignment): MetalsReasons {
    const reasons = new MetalsReasons();
    const ledger = assignment.metals.find((entry) => entry.metal === metal);
    for (const key of ledger?.contentUnknown.lots ?? []) reasons.add('content-unknown', key);
    for (const key of ledger?.contentUnknown.sales ?? []) reasons.add('content-unknown', key);
    for (const sale of assignment.sales) if (sale.metal === metal && sale.unmatchedUnits > 0) reasons.add('unmatched-sales', sale.key);
    for (const entry of this.lines(metal, 'buy')) {
      if (this.unitsAsOf(entry, asOf)?.dateUnknown) reasons.add('date-unknown', entry.key);
    }
    reasons.addAll(this.quarantined(metal, ['buy', 'sell']));
    reasons.addAll(this.ledgerWideHoldingReasons(metal, asOf));
    return reasons;
  }

  /**
   * The orders a later capture contradicts that a metal's figures can't rule out (Root's fail-closed ruling): every
   * quarantined order of the given sides with a line of the metal, or of unknown metal, in its active version or in any
   * conflicting one. The read side never reads the contradicting version, which could move the order's date, quantities,
   * money or content anywhere, so each figure an order of that side can change carries `conflict` for it, whatever its
   * date, its class or its place in the first-in, first-out order.
   */
  private quarantinedKeys(metal: Metal, sides: ReadonlyArray<'buy' | 'sell'>): string[] {
    return [...this.graph.orders.values()]
      .filter((order) => order.quarantined && sides.includes(order.order.side)
        && [...order.order.lines.map((line) => line.metal), ...order.conflictMetals].some((lineMetal) => lineMetal === metal || lineMetal === null))
      .map((order) => order.order.key);
  }

  private quarantined(metal: Metal, sides: ReadonlyArray<'buy' | 'sell'>): MetalsReasons {
    const reasons = new MetalsReasons();
    for (const key of this.quarantinedKeys(metal, sides)) reasons.add('conflict', key);
    return reasons;
  }

  /**
   * Every reason a sale line's cost basis and profit or loss carry (§8: never less than what could change them), which the
   * period's profit or loss carries for each of its sales too:
   * - its own: unknown content, unmatched units (`cost-estimated` instead when the owner's estimate switch gives them an
   *   estimated cost), an incomplete cost, fees or credits of its order not attributed to it (its net proceeds are
   *   approximate, H2), a date-uncertain cancellation or return in its class;
   * - the metal's unconfirmed content first-in, first-out could reach before it: a content-unknown lot ordered on or before
   *   its agreed day, or a content-unknown sale agreed on or before it (confirming either can move its units);
   * - every quarantined order of the metal (fail-closed);
   * - the held records and coverage gaps of either side up to its day.
   */
  saleReasons(line: MetalsSaleLine, metal: Metal, assignment: MetalsAssignment): MetalsReasons {
    // Every quarantined order of the metal, its own included (fail-closed).
    const reasons = this.quarantined(metal, ['buy', 'sell']);
    if (!line.contentKnown) reasons.add('content-unknown', line.key);
    if (line.unmatchedUnits > 0) reasons.add(this.estimateOf(line, assignment) ? 'cost-estimated' : 'unmatched-sales', line.key);
    if (line.costIncomplete) reasons.add('cost-unattributed', line.key);
    if (this.graph.lineByKey.get(line.key)?.line.complete === false) reasons.add('cost-unattributed', line.key);
    if (line.dateUnknownLots.length > 0) reasons.add('date-unknown', line.key);
    const unconfirmed = assignment.metals.find((entry) => entry.metal === metal)?.contentUnknown;
    for (const key of unconfirmed?.lots ?? []) {
      const lot = this.graph.lineByKey.get(key);
      if (lot !== undefined && lot.order.order.date <= line.agreedDay) reasons.add('content-unknown', key);
    }
    for (const key of unconfirmed?.sales ?? []) {
      const sale = this.graph.lineByKey.get(key);
      if (sale !== undefined && sale.order.order.date <= line.agreedDay) reasons.add('content-unknown', key);
    }
    reasons.addAll(this.ledgerWideHoldingReasons(metal, line.agreedDay < this.today ? line.agreedDay : this.today));
    return reasons;
  }

  /**
   * Whether a line of known content belongs to a class: its metal, its class form (its form's, or `any` for a metal the
   * owner's fungible policy names) and its fine ounces per unit.
   */
  private inClass(entry: MetalsLedgerLine, ledgerClass: MetalsClassLedger): boolean {
    const fine = this.fineOf(entry);
    return fine !== null && entry.line.metal === ledgerClass.metal
      && metalsAssignmentClassForm(ledgerClass.metal, entry.line.form, this.policy) === ledgerClass.form
      && equals(fine, ledgerClass.fineTroyOzPerUnit);
  }

  /**
   * A class's own reasons as of `asOf` (§8, completeness on every measure): its lots' date-unknown (G1d) and its unmatched
   * sales. The metal-wide ones (quarantined orders, unknown content) and the ledger-wide ones (held records, coverage)
   * are added by the caller.
   */
  private classReasons(ledgerClass: MetalsClassLedger, assignment: MetalsAssignment): MetalsReasons {
    const reasons = new MetalsReasons();
    for (const key of ledgerClass.dateUnknownLots) reasons.add('date-unknown', key);
    for (const sale of assignment.sales) {
      const entry = sale.unmatchedUnits > 0 ? this.graph.lineByKey.get(sale.key) : undefined;
      if (entry && this.inClass(entry, ledgerClass)) reasons.add('unmatched-sales', sale.key);
    }
    return reasons;
  }

  /** Lots' kept units as of a day (delivered and kept, or on the way) and their cost: each unit's share, as `bought` reads it. */
  private keptOf(keys: readonly string[], asOf: string): { units: number; costMinor: number } {
    let units = 0;
    let costMinor = 0;
    for (const key of keys) {
      const entry = this.graph.lineByKey.get(key);
      const lotUnits = entry ? this.unitsAsOf(entry, asOf) : null;
      if (!entry || !lotUnits) continue;
      const kept = lotUnits.delivered + lotUnits.awaiting;
      units += kept;
      costMinor += metalsUnitSplit(entry.line.costMinor ?? 0, lotUnits.ordered).slice(0, kept).reduce((total, cost) => total + cost, 0);
    }
    return { units, costMinor };
  }

  /**
   * Where a sale order's payouts show on a metal's page: its own figures only when the sale is provably that metal alone,
   * that is every line of the metal and no non-metal item in its skeleton (the buy side's all-metal rule, mirrored);
   * otherwise apart (`mixedMetal`) when it has a line of the metal or of unknown metal (an order whose every line is of
   * unknown metal shows apart on every page, never in a metal's totals); nowhere when its lines are all of other, known
   * metals.
   */
  private payoutPlace(order: MetalsLedgerOrder, metal: Metal): 'own' | 'apart' | null {
    const lines = order.order.lines;
    if (lines.length > 0 && lines.every((line) => line.metal === metal) && allMetalOrder(order.order.skeleton)) return 'own';
    return lines.some((line) => line.metal === metal || line.metal === null) ? 'apart' : null;
  }

  /** Sale orders that count: an order held for metals pays out nothing on any page (its payouts only contest credits). */
  private sellOrders(): MetalsLedgerOrder[] {
    return [...this.graph.orders.values()].filter((order) => order.order.side === 'sell' && !order.heldForMetals);
  }

  // -------------------------------------------------------------------------
  // Holdings
  // -------------------------------------------------------------------------

  /**
   * Recorded holdings of a metal as of a day: ounces, cost, value and gain at spot, by class and source. A holding that
   * proves it holds nothing (`provesNothingHeld`) is valued at exactly 0, known, with no price reason.
   */
  holdings(metal: Metal, asOf: string): { holdings: MetalsOverview['holdings']; reasons: MetalsReasons } {
    const assignment = this.assignment(asOf);
    const ledger = assignment.metals.find((entry) => entry.metal === metal);
    const classes = ledger?.classes ?? [];
    const base = this.holdingReasons(metal, asOf, assignment);
    const costReasons = unionReasons(base);
    for (const ledgerClass of classes) for (const key of ledgerClass.heldCostIncompleteLots) costReasons.add('cost-unattributed', key);
    const priceReasons = this.priceReasons(metal, asOf);
    const close = this.closeOn(metal, asOf);

    const heldOz = classes.map((entry) => timesUnits(entry.fineTroyOzPerUnit, entry.units.held));
    const totalOz = sumOz(heldOz);
    const unknownLots = ledger?.contentUnknown.lots.length ?? 0;
    const troyOz = heldTroyOz(totalOz, base);
    const costMinor = classes.reduce((total, entry) => total + entry.cents.heldCosts, 0);
    const cost = metalsMeasure(troyOz.value === null ? null : costMinor, costReasons);
    const awaiting = (oz: Rational) => (troyOz.value === null ? metalsMeasure<MetalsTroyOz>(null, base) : heldTroyOz(oz, base));
    const units: MetalsClassUnits = {
      delivered: 0, awaiting: 0, sold: 0, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0,
    };
    for (const entry of classes) for (const key of Object.keys(units) as Array<keyof MetalsClassUnits>) units[key] += entry.units[key];
    const contentUnknownKept = this.keptOf(ledger?.contentUnknown.lots ?? [], asOf);
    // Units of unknown metal kept in the ledger, held or awaiting (the overview's own count): any could be this metal's.
    const metalUnknownKept = this.keptOf(assignment.metalUnknown.lots, asOf).units;
    const nothingHeld = provesNothingHeld(troyOz, units, metalUnknownKept, contentUnknownKept.units);
    const valued = close === null || troyOz.value === null ? null : metalsValueParts(heldOz, close.close);
    const valueTotal = nothingHeld ? 0 : valued?.totalMinor ?? null;
    const value = metalsMeasure(valueTotal, nothingHeld ? unionReasons(base) : unionReasons(base, priceReasons));
    const gain = metalsMeasure(valueTotal === null || cost.value === null ? null : valueTotal - cost.value,
      nothingHeld ? unionReasons(costReasons) : unionReasons(costReasons, priceReasons));
    const classValues: Array<number | null> = valued?.partsMinor ?? classes.map(() => null);

    const ledgerWide = this.ledgerWideHoldingReasons(metal, asOf);
    // Content the owner hasn't confirmed can add a lot to any class of the metal, or a sale that takes its earliest unit.
    const contentUnknown = new MetalsReasons();
    for (const key of ledger?.contentUnknown.lots ?? []) contentUnknown.add('content-unknown', key);
    for (const key of ledger?.contentUnknown.sales ?? []) contentUnknown.add('content-unknown', key);
    /** Each class's full reasons (§8): its own, the metal's quarantined orders and unknown content, and the ledger-wide ones. */
    const quarantinedOrders = this.quarantined(metal, ['buy', 'sell']);
    const classFull = new Map(classes.map((entry) => [entry.key,
      unionReasons(this.classReasons(entry, assignment), quarantinedOrders, ledgerWide, contentUnknown)]));
    const holdingClasses: MetalsHoldingClass[] = classes.map((entry, index) => {
      const own = classFull.get(entry.key)!;
      const classCost = unionReasons(own);
      for (const key of entry.heldCostIncompleteLots) classCost.add('cost-unattributed', key);
      const classOz = heldTroyOz(heldOz[index], own);
      const classNothingHeld = provesNothingHeld(classOz, entry.units, metalUnknownKept);
      const classValue = classNothingHeld ? 0 : classOz.value === null ? null : classValues[index];
      const classCostMinor = classOz.value === null ? null : entry.cents.heldCosts;
      return {
        key: entry.key,
        form: entry.form,
        fineTroyOzPerUnit: metalsTroyOz(entry.fineTroyOzPerUnit),
        units: { ...entry.units },
        troyOz: classOz,
        costMinor: metalsMeasure(classCostMinor, classCost),
        valueMinor: metalsMeasure(classValue, classNothingHeld ? unionReasons(own) : unionReasons(own, priceReasons)),
        gainMinor: metalsMeasure(classValue === null || classCostMinor === null ? null : classValue - classCostMinor,
          classNothingHeld ? classCost : unionReasons(classCost, priceReasons)),
        reconciliation: {
          balanced: entry.units.delivered - entry.units.sold === entry.units.held,
          soldWhileAwaiting: entry.units.soldFromAwaiting,
          unmatched: entry.units.unmatched,
          ...(entry.deliveryInferred === undefined ? {} : { deliveryInferred: entry.deliveryInferred }),
        },
        ...(this.estimatesCostOf(metal) ? { estimate: this.classEstimate(entry.key, asOf) } : {}),
      };
    });

    return {
      holdings: {
        troyOz,
        costMinor: cost,
        valueMinor: value,
        gainMinor: gain,
        units,
        awaitingTroyOz: awaiting(sumOz(classes.map((entry) => timesUnits(entry.fineTroyOzPerUnit, entry.units.awaiting)))),
        awaitingUnassignedTroyOz: awaiting(sumOz(classes.map((entry) => timesUnits(entry.fineTroyOzPerUnit, entry.units.awaitingUnassigned)))),
        contentUnknown: {
          lots: unknownLots,
          units: contentUnknownKept.units,
          costMinor: contentUnknownKept.costMinor,
          sales: ledger?.contentUnknown.sales.length ?? 0,
          saleNetMinor: ledger?.contentUnknown.saleNetMinor ?? 0,
        },
        classes: holdingClasses,
        bySource: this.holdingsBySource(metal, assignment, classFull, quarantinedOrders, close, priceReasons, metalUnknownKept),
        storage: null,
      },
      reasons: base,
    };
  }

  /**
   * Recorded holdings per source account. First-in, first-out runs over one queue per class across every account, so
   * another account's gap, hold, quarantine or uncertain date can move a sale onto or off this account's lots: a row
   * inherits the full reasons of every class it holds or held a lot in, beside its own lots', and every row carries the
   * metal's quarantined orders (fail-closed). Values split the metal's value by largest remainder over the rows'
   * ounces, so they add up to it; a row that proves it holds nothing (`provesNothingHeld`: none held or awaiting, its
   * ounces known, and no lot of unknown metal kept in the ledger) is valued at 0 without a price.
   */
  private holdingsBySource(metal: Metal, assignment: MetalsAssignment, classFull: ReadonlyMap<string, MetalsReasons>,
    quarantinedOrders: MetalsReasons, close: MetalsAdmissibleClose | null, priceReasons: MetalsReasons, metalUnknownKept: number): MetalsHoldingSource[] {
    const positions = this.lotPositions(assignment);
    const asOf = assignment.asOf;
    const classes = assignment.metals.find((entry) => entry.metal === metal)?.classes ?? [];
    const bySource = new Map<string, {
      account: MetalsAccountRef; units: number; awaiting: number; oz: Rational; cost: number; reasons: MetalsReasons; costReasons: MetalsReasons;
    }>();
    for (const entry of this.lines(metal, 'buy')) {
      const units = this.unitsAsOf(entry, asOf);
      if (!units) continue;
      const account = entry.order.account;
      let row = bySource.get(account.accountId);
      if (!row) {
        row = { account, units: 0, awaiting: 0, oz: ZERO, cost: 0, reasons: unionReasons(quarantinedOrders), costReasons: new MetalsReasons() };
        bySource.set(account.accountId, row);
      }
      // Every lot's units on the way, of known content or not: a row with any is not proven to hold nothing. Under the
      // owner's fungible policy the units sales took from awaiting (beyond its delivered ones) read delivered.
      const position = positions.get(entry.key);
      const inferred = position !== undefined && this.policy.fungible.includes(metal)
        ? Math.max(0, position.assigned - units.delivered) : 0;
      row.awaiting += units.awaiting - inferred;
      if (units.dateUnknown) row.reasons.add('date-unknown', entry.key);
      const fine = this.fineOf(entry);
      if (fine === null) {
        row.reasons.add('content-unknown', entry.key);
        continue;
      }
      const lotClass = classes.find((candidate) => this.inClass(entry, candidate));
      if (lotClass) row.reasons.addAll(classFull.get(lotClass.key) ?? new MetalsReasons());
      if (!position) continue;
      row.units += position.held;
      row.oz = add(row.oz, timesUnits(fine, position.held));
      row.cost += position.heldCostMinor;
      if (position.held > 0 && !entry.line.complete) row.costReasons.add('cost-unattributed', entry.key);
    }
    // Each account's own records: its kinds' coverage up to the day, and its open held records (a row of content-unknown
    // lots only, in no class, still says so).
    for (const row of bySource.values()) {
      for (const gap of this.coverageGaps([row.account.source], HOLDING_KINDS, null, asOf, { accountId: row.account.accountId })) row.reasons.add('not-covered', gap);
      for (const held of this.held(metal, null, null, asOf)) if (held.accountId === row.account.accountId) row.reasons.add('source-held', held.record);
    }
    const rows = [...bySource.values()]
      .sort((a, b) => compareText(a.account.label, b.account.label) || compareText(a.account.accountId, b.account.accountId));
    const valued = close === null ? null : metalsValueParts(rows.map((row) => row.oz), close.close);
    return rows.map((row, index) => {
      // A row of content-unknown lots only holds a zero that carries their reason, so it reads unknown too.
      const troyOz = heldTroyOz(row.oz, row.reasons);
      const nothingHeld = provesNothingHeld(troyOz, { held: row.units, awaiting: row.awaiting }, metalUnknownKept);
      return {
        ...row.account,
        units: row.units,
        troyOz,
        costMinor: metalsMeasure(troyOz.value === null ? null : row.cost, unionReasons(row.reasons, row.costReasons)),
        valueMinor: metalsMeasure(nothingHeld ? 0 : troyOz.value === null || valued === null ? null : valued.partsMinor[index],
          nothingHeld ? unionReasons(row.reasons) : unionReasons(row.reasons, priceReasons)),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  /** The overview but its coverage proof, which the route adds from the snapshot's card check (cardCheck.ts). */
  overview(metal: Metal, period: { from: string | null; to: string }, asOf: string): Omit<MetalsOverview, 'coverageProof'> {
    const { holdings } = this.holdings(metal, asOf);
    const unknown = this.assignment(asOf).metalUnknown;
    const unknownKept = this.keptOf(unknown.lots, asOf);
    return {
      installed: true,
      metal,
      metals: METALS.map((entry) => ({ metal: entry, lots: this.lines(entry, 'buy').length, sales: this.lines(entry, 'sell').length }))
        .filter((entry) => entry.lots + entry.sales > 0),
      asOf,
      price: this.priceUsed(metal, asOf),
      holdings,
      metalUnknown: {
        lots: unknown.lots.length, units: unknownKept.units, costMinor: unknownKept.costMinor, sales: unknown.sales.length,
        saleNetMinor: unknown.saleNetMinor,
      },
      activity: this.activity(metal, period),
      toCheck: this.toCheck(metal),
      needsAnswer: this.needsAnswer(metal),
      coverage: this.coverageEntries(),
      ...this.method(),
      ...this.estimateMethod(),
    };
  }

  /**
   * The orders held for metals on the metal's page (`heldOrdersOn`), each with every line the title guard flagged and
   * where it stands, until the owner answers them all. Their lines are in no figure; every figure they would reach says
   * `source-held`.
   */
  needsAnswer(metal: Metal): MetalsNeedsAnswer {
    const orders = this.heldOrdersOn(metal);
    const heldKeys = new Set(orders.map((order) => order.order.key));
    const items = this.answerLines(this.graph.flagged.filter((entry) => heldKeys.has(entry.order.order.key)));
    const flaggedOf = (orderKey: string) => items.filter((item) => item.orderKey === orderKey).length;
    const bySource = METALS_SOURCES.map((source) => {
      const ofSource = orders.filter((order) => order.source === source);
      return { source, orders: ofSource.length, flaggedLines: ofSource.reduce((total, order) => total + flaggedOf(order.order.key), 0) };
    }).filter((row) => row.orders > 0);
    const byMerchantClass = CARD_METALS_MERCHANT_CLASSES.map((merchantClass) => ({
      merchantClass,
      orders: orders.filter((order) => metalsMerchantClass(order.source, order.order.channel) === merchantClass).length,
    })).filter((row) => row.orders > 0);
    return { orders: orders.length, flaggedLines: items.length, bySource, byMerchantClass, items };
  }

  /**
   * Every flagged line of every order on the metal's page, held, counted or left the ledger, in every state: the page
   * rule of `heldOrdersOn` on the order as stored (each flag metal, each other line's metal, every metal when one is
   * unknown), whatever the owner answered since.
   */
  answers(metal: Metal): MetalsAnswers {
    const onPage = this.graph.flagged.filter((entry) => metalsHeldOrderMetals(entry.order.stored).some((named) => named === metal || named === null));
    return { installed: true, metal, items: this.answerLines(onPage) };
  }

  /** Flagged lines as the owner sees them, by date, then order key, then line key. */
  private answerLines(entries: readonly MetalsFlaggedLine[]): MetalsAnswerLine[] {
    // Stored rows: a product answer holds its ref and fingerprint, a lot answer its key and pinned digest (G2's CHECKs).
    const decisionOf = (decision: MetalsBullionDecisionInput): MetalsBullionDecision => ({
      id: decision.id,
      answer: decision.answer,
      scope: decision.scope === 'product'
        ? { kind: 'product', ref: decision.productRef!, fingerprint: decision.fingerprint! }
        : { kind: 'lot', lotKey: decision.lotKey!, evidenceDigest: decision.evidenceDigest! },
      decidedAt: decision.decidedAt,
    });
    return entries.map(({ line, order, answer, drift, scope, decision }): MetalsAnswerLine => ({
      lineKey: line.key,
      orderKey: order.order.key,
      side: order.order.side,
      account: order.account,
      date: order.order.date,
      title: line.title,
      productRef: line.productRef,
      units: line.quantity,
      amountMinor: line.amountMinor,
      flag: { metal: line.metalUncertain?.metal ?? null, evidence: [...(line.metalUncertain?.evidence ?? [])] },
      state: answer ?? (drift ? 'drift' : 'needs-your-answer'),
      scope: scope.kind === 'product' ? { kind: 'product', ref: scope.ref, fingerprint: scope.fingerprint }
        : { kind: 'lot', lotKey: scope.lotKey, evidenceDigest: order.digest },
      decision: decision === null ? null : decisionOf(decision),
      orderHeld: order.heldForMetals,
    })).sort((a, b) => compareText(a.date, b.date) || compareText(a.orderKey, b.orderKey) || compareText(a.lineKey, b.lineKey));
  }

  activity(metal: Metal, period: { from: string | null; to: string }): MetalsOverview['activity'] {
    const { from, to } = period;
    const today = this.assignment(this.today);
    // Fail-closed: a contradicted order's other version could be dated in any period, so each side's figures carry its
    // quarantined orders whatever their dates.
    const quarantinedBuys = this.quarantined(metal, ['buy']);
    const quarantinedSales = this.quarantined(metal, ['sell']);

    // Bought: by order date; units neither cancelled nor returned, as known today.
    const boughtReasons = unionReasons(quarantinedBuys);
    const boughtCostReasons = new MetalsReasons();
    let lots = 0;
    let units = 0;
    let oz = ZERO;
    let costMinor = 0;
    let known = false;
    let unknown = false;
    const buyLines = this.lines(metal, 'buy').filter((entry) => within(entry.order.order.date, from, to));
    for (const entry of buyLines) {
      const lotUnits = this.unitsAsOf(entry, this.today);
      if (!lotUnits) continue;
      const kept = lotUnits.delivered + lotUnits.awaiting;
      if (kept === 0) continue;
      lots += 1;
      units += kept;
      costMinor += metalsUnitSplit(entry.line.costMinor ?? 0, lotUnits.ordered).slice(0, kept).reduce((total, cost) => total + cost, 0);
      const fine = this.fineOf(entry);
      if (fine === null) {
        unknown = true;
        boughtReasons.add('content-unknown', entry.key);
      } else {
        known = true;
        oz = add(oz, timesUnits(fine, kept));
      }
      if (lotUnits.dateUnknown) boughtReasons.add('date-unknown', entry.key);
      if (!entry.line.complete) boughtCostReasons.add('cost-unattributed', entry.key);
    }
    const buyStart = from ?? this.earliest(BUY_SOURCES);
    /** Coverage is judged through today at most: days still to come can't be captured. */
    const coverTo = to < this.today ? to : this.today;
    for (const held of this.held(metal, BUY_SOURCES, from, to)) boughtReasons.add('source-held', held.record);
    if (buyStart !== null) {
      for (const gap of this.coverageGaps(BUY_SOURCES, (source) => KINDS[source], buyStart, coverTo)) boughtReasons.add('not-covered', gap);
    }

    // Sold: by agreed day; every line not cancelled; money stated for each, content known or not.
    const soldReasons = new MetalsReasons();
    /** The sell side's gaps in the period, which profit or loss carries too. */
    const sellGaps = unionReasons(quarantinedSales);
    const sellLines = this.lines(metal, 'sell')
      .filter((entry) => entry.order.order.status !== 'cancelled' && within(entry.order.order.date, from, to));
    let soldOz = ZERO;
    let soldKnown = false;
    let soldUnknown = false;
    for (const entry of sellLines) {
      const fine = this.fineOf(entry);
      if (fine === null) {
        soldUnknown = true;
        soldReasons.add('content-unknown', entry.key);
      } else {
        soldKnown = true;
        soldOz = add(soldOz, timesUnits(fine, entry.line.quantity));
      }
    }
    const sellStart = from ?? this.earliest(SELL_SOURCES);
    for (const held of this.held(metal, SELL_SOURCES, from, to)) sellGaps.add('source-held', held.record);
    if (sellStart !== null) {
      for (const gap of this.coverageGaps(SELL_SOURCES, () => ['sell-orders'], sellStart, coverTo)) sellGaps.add('not-covered', gap);
    }
    soldReasons.addAll(sellGaps);
    const gross = sellLines.reduce((total, entry) => total + entry.line.amountMinor, 0);
    const net = sellLines.reduce((total, entry) => total + (entry.line.netMinor ?? 0), 0);
    // A line whose order's fees or credits couldn't be attributed to it (H2): its fees and net proceeds are approximate.
    const soldMoneyReasons = unionReasons(sellGaps);
    for (const entry of sellLines) if (!entry.line.complete) soldMoneyReasons.add('cost-unattributed', entry.key);

    // Profit or loss on sales agreed in the period, with its coverage (G1d): the sell side's gaps in the period, and every
    // reason that could change a sale's own result (`saleReasons`), so no sale row looks complete while the profit isn't.
    const profit = metalsProfitOnSales(today, metal, from ?? EARLIEST, to);
    const profitReasons = unionReasons(sellGaps);
    const periodSales = today.sales.filter((line) => line.metal === metal && within(line.agreedDay, from, to));
    for (const line of periodSales) profitReasons.addAll(this.saleReasons(line, metal, today));
    // A quarantined sale's other version could be agreed in the period, and then the buy side's contradicted orders could
    // change what it took: with a sale in the period (which carries them already) or any quarantined sale, profit or loss
    // carries every quarantined order of the metal.
    if (periodSales.length > 0 || this.quarantinedKeys(metal, ['sell']).length > 0) profitReasons.addAll(this.quarantined(metal, ['buy', 'sell']));
    const coverage: MetalsProfitCoverage = profit.coverage.basis === 'troy-oz'
      ? { basis: 'troy-oz', known: metalsTroyOz(readRational(profit.coverage.known) ?? ZERO), total: metalsTroyOz(readRational(profit.coverage.total) ?? ZERO), unknownContentLines: 0 }
      : { basis: 'sale-lines', known: Number(profit.coverage.known), total: Number(profit.coverage.total), unknownContentLines: profit.coverage.unknownContentLines };
    const unmatchedLines = periodSales.filter((line) => line.unmatchedUnits > 0);
    const unmatched = {
      units: unmatchedLines.reduce((total, line) => total + line.unmatchedUnits, 0),
      netMinor: unmatchedLines.reduce((total, line) => total + line.unmatchedNetMinor, 0),
      reasons: mergeUnmatched(unmatchedLines.flatMap((line) => this.unmatchedParts(line.key))),
    };

    // Payouts by payout date, of sale orders that are provably the metal alone (`payoutPlace`). An order with a line of
    // another metal or of unknown metal, or a non-metal item, isn't one metal alone: its payouts are listed apart, with
    // the same gaps. Either list carries every quarantined sale of the metal (fail-closed: its other version could be
    // paid in the period, or in either list).
    const payoutGaps = unionReasons(quarantinedSales);
    const mixedGaps = unionReasons(quarantinedSales);
    let payoutCount = 0;
    let payoutMinor = 0;
    let mixedCount = 0;
    let mixedMinor = 0;
    for (const order of this.sellOrders()) {
      const place = this.payoutPlace(order, metal);
      if (place === null) continue;
      const paid = order.order.payouts.filter((payout) => payout.payoutDate !== null && within(payout.payoutDate, from, to));
      if (paid.length === 0) continue;
      const amount = paid.reduce((total, payout) => total + payout.amountMinor, 0);
      if (place === 'own') {
        payoutCount += paid.length;
        payoutMinor += amount;
      } else {
        mixedCount += paid.length;
        mixedMinor += amount;
      }
    }
    // A sale is paid out after it is agreed: an open held sell record dated on or before the period's end (or undated),
    // and sell orders or payouts not covered from the earlier of the period's start (in all time, the first sale) and the
    // kind's first covered day, can hide a payout of either kind.
    const sellSideGaps = new MetalsReasons();
    for (const held of this.held(metal, SELL_SOURCES, null, to)) sellSideGaps.add('source-held', held.record);
    for (const gap of this.coverageGaps(SELL_SOURCES, () => ['sell-orders', 'payouts'], sellStart, coverTo, { earlierOfFirstCovered: true })) {
      sellSideGaps.add('not-covered', gap);
    }
    payoutGaps.addAll(sellSideGaps);
    mixedGaps.addAll(sellSideGaps);

    return {
      from,
      to,
      bought: {
        lots,
        units,
        troyOz: partialSum(metalsTroyOz(oz), known, unknown, boughtReasons),
        costMinor: metalsMeasure(costMinor, unionReasons(boughtReasons, boughtCostReasons)),
      },
      sold: {
        lines: sellLines.length,
        units: sellLines.reduce((total, entry) => total + entry.line.quantity, 0),
        troyOz: partialSum(metalsTroyOz(soldOz), soldKnown, soldUnknown, soldReasons),
        grossMinor: metalsMeasure(gross, sellGaps),
        feesMinor: metalsMeasure(gross - net, soldMoneyReasons),
        netMinor: metalsMeasure(net, soldMoneyReasons),
        unmatched,
      },
      profit: this.profitOf(metal, today, from, to, profit.profit.value, profitReasons, coverage),
      payouts: {
        count: payoutCount,
        amountMinor: metalsMeasure(payoutMinor, payoutGaps),
        mixedMetal: { count: mixedCount, amountMinor: metalsMeasure(mixedMinor, mixedGaps) },
      },
    };
  }

  /**
   * A period's profit or loss: the recorded value (`metalsProfitOnSales`), or while the owner's estimate switch names the
   * metal, the value with the estimates in (`metalsProfitOnSalesWithEstimates`) and what it sums, part by part.
   */
  private profitOf(metal: Metal, today: MetalsAssignment, from: string | null, to: string, recorded: number | null, reasons: MetalsReasons,
    coverage: MetalsProfitCoverage): MetalsOverview['activity']['profit'] {
    const estimates = this.estimatesCostOf(metal) ? this.estimates(today.asOf) : null;
    if (estimates === null) return { valueMinor: metalsMeasure(recorded, reasons), coverage };
    const valued = metalsProfitOnSalesWithEstimates(today, estimates.estimates, metal, from ?? EARLIEST, to);
    const estimate: MetalsProfitEstimate = {
      recordedMinor: valued.recorded.profitMinor,
      estimatedMinor: valued.estimated.profitMinor,
      costOfSales: { recordedMinor: valued.recorded.costMinor, estimatedMinor: valued.estimated.costMinor },
      estimated: { lines: valued.estimated.lines, units: valued.estimated.units, troyOz: metalsTroyOz(valued.estimated.troyOz) },
      unestimatedUnits: valued.unestimatedUnits,
    };
    return { valueMinor: metalsMeasure(valued.valueMinor, reasons), coverage, estimate };
  }

  /** The earliest order or agreed day of a side's sources, or null when it has none. */
  private earliest(sources: readonly MetalsSource[]): string | null {
    let earliest: string | null = null;
    for (const entry of this.graph.orders.values()) {
      if (!sources.includes(entry.source)) continue;
      if (earliest === null || entry.order.date < earliest) earliest = entry.order.date;
    }
    return earliest;
  }

  toCheck(metal: Metal): MetalsOverview['toCheck'] {
    const products = this.productRows(metal);
    const confirm = products.filter((row) => row.hold !== null && !row.drift && row.hold !== 'metal-unknown').length;
    const drift = products.filter((row) => row.drift).length;
    const needsYou: MetalsNeedsYou[] = [];
    // Orders held for metals wait for the owner's answer first: until then every line of them is in no figure.
    const answer = this.needsAnswer(metal);
    if (answer.orders > 0) needsYou.push({ code: 'bullion-answer', orders: answer.orders, flaggedLines: answer.flaggedLines });
    if (confirm > 0) needsYou.push({ code: 'confirm-content', products: confirm });
    if (drift > 0) needsYou.push({ code: 'confirmation-drift', products: drift });

    const today = this.assignment(this.today);
    const forInformation: MetalsForInformation[] = [];
    let records = answer.orders + confirm + drift;
    const unmatchedLines = today.sales.filter((line) => line.metal === metal && line.unmatchedUnits > 0);
    const unmatchedUnits = unmatchedLines.reduce((total, line) => total + line.unmatchedUnits, 0);
    if (unmatchedUnits > 0) {
      const reasons = mergeUnmatched(unmatchedLines.flatMap((line) => this.unmatchedParts(line.key))).map(({ reason, units }) => ({ reason, units }));
      forInformation.push({ code: 'unmatched-sales', units: unmatchedUnits, reasons });
      records += unmatchedLines.length;
    }

    const buyOrders = new Set(this.lines(metal, 'buy').map((entry) => entry.order.order.key));
    const unlinked = [...buyOrders].flatMap((key) => this.graph.cardLinksByOrder.get(key) ?? []).filter((link) => link.state !== 'linked');
    if (unlinked.length > 0) {
      const counts = new Map<string, number>();
      for (const link of unlinked) counts.set(link.state, (counts.get(link.state) ?? 0) + 1);
      forInformation.push({
        code: 'card-not-linked', charges: unlinked.length,
        states: [...counts.entries()].sort(([a], [b]) => compareText(a, b))
          .map(([state, count]) => ({ state: state as Exclude<typeof unlinked[number]['state'], 'linked'>, count })),
      });
      records += unlinked.length;
    }

    // Unlinked deposits of sale orders whose every line is the metal; those of orders with a line of another metal or of
    // unknown metal are listed apart (an order of unknown metal only, on every page).
    const unlinkedDeposits = (orders: readonly MetalsLedgerOrder[]) => orders.flatMap((order) => order.order.payouts
      .map((payout) => ({ payout, deposit: this.depositOf(payout, order.source) })))
      .filter(({ deposit }) => deposit.state !== 'linked');
    const deposits = unlinkedDeposits(this.sellOrders().filter((order) => this.payoutPlace(order, metal) === 'own'));
    const mixedDeposits = unlinkedDeposits(this.sellOrders().filter((order) => this.payoutPlace(order, metal) === 'apart'));
    if (deposits.length + mixedDeposits.length > 0) {
      const states = new Map<string, { count: number; coveredThrough: string | null }>();
      for (const { deposit } of deposits) {
        const entry = states.get(deposit.state) ?? { count: 0, coveredThrough: deposit.coveredThrough };
        entry.count += 1;
        if (entry.coveredThrough !== null && (deposit.coveredThrough === null || deposit.coveredThrough < entry.coveredThrough)) {
          entry.coveredThrough = deposit.coveredThrough;
        }
        states.set(deposit.state, entry);
      }
      forInformation.push({
        code: 'deposit-not-linked', deposits: deposits.length,
        states: [...states.entries()].sort(([a], [b]) => compareText(a, b)).map(([state, entry]) => ({
          state: state as Exclude<MetalsSalePayout['deposit']['state'], 'linked'>, count: entry.count,
          coveredThrough: state === 'not-covered' ? entry.coveredThrough : null,
        })),
        mixedMetal: mixedDeposits.length,
      });
      records += deposits.length + mixedDeposits.length;
    }

    if (this.graph.openHolds.length > 0) {
      const reasons = new Map<string, number>();
      for (const hold of this.graph.openHolds) reasons.set(hold.reason, (reasons.get(hold.reason) ?? 0) + 1);
      forInformation.push({
        code: 'source-held', records: this.graph.openHolds.length,
        reasons: [...reasons.entries()].sort(([a], [b]) => compareText(a, b))
          .map(([reason, count]) => ({ reason: reason as typeof this.graph.openHolds[number]['reason'], count })),
      });
      records += this.graph.openHolds.length;
    }
    const conflictOrders = this.quarantinedKeys(metal, ['buy', 'sell']);
    if (conflictOrders.length > 0) {
      forInformation.push({ code: 'conflict', orders: conflictOrders.length });
      records += conflictOrders.length;
    }
    const undated = this.lines(metal, 'buy').filter((entry) => this.unitsAsOf(entry, this.today)?.dateUnknown).length;
    if (undated > 0) {
      forInformation.push({ code: 'date-unknown', records: undated });
      records += undated;
    }
    const unattributed = new Set(this.lines(metal, 'buy').filter((entry) => !entry.line.complete).map((entry) => entry.order.order.key));
    if (unattributed.size > 0) {
      forInformation.push({ code: 'cost-unattributed', orders: unattributed.size });
      records += unattributed.size;
    }
    const metalUnknown = this.graph.lines.filter((entry) => entry.line.metal === null).length;
    if (metalUnknown > 0) {
      forInformation.push({ code: 'metal-unknown', records: metalUnknown });
      records += metalUnknown;
    }
    const disagreeing = this.lines(metal, 'sell').filter((entry) => this.dealerSpotOf(entry).kind === 'premium-disagreement').length;
    if (disagreeing > 0) {
      forInformation.push({ code: 'premium-disagreement', records: disagreeing });
      records += disagreeing;
    }
    return { records, needsYou, forInformation };
  }

  coverageEntries(): MetalsCoverageEntry[] {
    // The latest import and coverage by G2's causal import sequence, never by time or the (random) import id. Coverage an
    // import this read doesn't know states is neither shown nor counted (H7), so every import ordered here is known.
    const rank = new Map(this.graph.imports.map((entry) => [entry.importId, entry.importSeq]));
    const order = (importId: string) => rank.get(importId) ?? Number.MAX_SAFE_INTEGER;
    const entries: MetalsCoverageEntry[] = [];
    for (const account of this.graph.accounts.values()) {
      const imports = this.graph.imports.filter((entry) => entry.accountId === account.accountId)
        .sort((a, b) => order(a.importId) - order(b.importId));
      const latest = imports[imports.length - 1];
      if (!latest) continue;
      // Only what an import this read knows states: the latest coverage shown and the ranges covered (a kind it alone
      // states isn't listed, as if never covered).
      const coverage = this.knownCoverage.filter((entry) => entry.accountId === account.accountId);
      const kinds = KINDS[account.source].flatMap((kind) => {
        const ofKind = coverage.filter((entry) => entry.kind === kind).sort((a, b) => order(a.importId) - order(b.importId));
        const last = ofKind[ofKind.length - 1];
        if (!last) return [];
        return [{
          kind, from: last.from, to: last.to, complete: last.complete, stated: last.stated, seen: last.seen,
          ranges: mergeRanges(ofKind.filter((entry) => entry.complete).map((entry) => ({ from: entry.from, to: entry.to }))),
        }];
      });
      entries.push({
        ...account,
        capturedAt: latest.capturedAt,
        importedAt: latest.importedAt,
        kinds,
        held: this.graph.openHolds.filter((hold) => hold.accountId === account.accountId).length,
      });
    }
    return entries.sort((a, b) => compareText(a.source, b.source) || compareText(a.label, b.label) || compareText(a.accountId, b.accountId));
  }

  // -------------------------------------------------------------------------
  // Purchases, sales and links
  // -------------------------------------------------------------------------

  /** A card account as every read shows one (a card row's account, the card check's rows and card history). */
  cardAccountView(accountId: string): MetalsLinkedAccount {
    const account = this.graph.cardAccounts.get(accountId);
    return {
      id: accountId,
      name: account?.nickname ?? account?.issuer ?? 'Card',
      ending: account?.last5 ?? account?.last4 ?? null,
      ...(account ? { issuer: account.issuer, owner: account.owner } : {}),
    };
  }

  cardsOf(order: MetalsLedgerOrder): { cardEvidence: MetalsPurchase['cardEvidence']; cards: MetalsPurchaseCard[] } {
    const cardEvidence = order.admission === null ? 'none' : order.admission.basis === 'aggregate' ? 'aggregate' : 'admitted';
    const cards = (this.graph.cardLinksByOrder.get(order.order.key) ?? []).map((link): MetalsPurchaseCard => {
      const row = link.rowId === null ? undefined : this.graph.cardRows.get(link.rowId);
      return {
        evidenceClass: link.evidenceClass,
        amountMinor: link.amountMinor,
        state: link.state,
        proof: link.proof,
        row: row ? { id: row.id, date: row.date, account: this.cardAccountView(row.accountId) } : null,
      };
    });
    return { cardEvidence, cards };
  }

  depositOf(payout: MetalsPayout, source: MetalsSource = 'collectpure'): MetalsSalePayout['deposit'] {
    const link = this.graph.depositLinks.get(payout.key);
    const bound = payout.destinationLast4 === null ? undefined : this.graph.checkingBindingByLast4.get(`${source}|${payout.destinationLast4}`);
    const row = link?.rowId ? this.graph.checkingRows.get(link.rowId) : undefined;
    const account = row ? this.graph.checkingAccounts.get(row.accountId) : undefined;
    return {
      state: link?.state ?? 'binding-missing',
      proof: link?.proof ?? false,
      row: row ? { id: row.id, date: row.date, account: { id: row.accountId, name: account?.label ?? 'Checking', ending: account?.last4 ?? null } } : null,
      coveredThrough: bound === undefined ? null : (this.graph.checkingCoveredThrough.get(bound) ?? null),
    };
  }

  payoutsOf(order: MetalsLedgerOrder): MetalsSalePayout[] {
    return order.order.payouts.map((payout) => ({
      key: payout.key, amountMinor: payout.amountMinor, payoutDate: payout.payoutDate, status: payout.status,
      deposit: this.depositOf(payout, order.source),
    }));
  }

  contentOf(entry: MetalsLedgerLine): MetalsContent {
    const fine = this.fineOf(entry);
    if (fine !== null) {
      const basis = entry.content.known ? entry.content.basis : 'owner-confirmed';
      return { known: true, troyOzPerUnit: metalsTroyOz(fine), troyOz: metalsTroyOz(timesUnits(fine, entry.line.quantity)), basis };
    }
    return entry.content.known
      ? { known: false, hold: 'fine-content-unknown', missing: ['fine-content-unknown'] }
      : { known: false, hold: entry.content.hold, missing: [...entry.content.missing] };
  }

  private delivery(entry: MetalsLedgerLine, units: MetalsLotUnits): MetalsPurchase['delivery'] {
    const events = entry.line.events;
    let state: MetalsDeliveryState;
    let date: string | null;
    if (units.cancelled === units.ordered) [state, date] = ['cancelled', lastEventDate(events, 'cancelled')];
    else if (units.delivered === 0 && units.awaiting === 0) [state, date] = ['returned', lastEventDate(events, 'returned')];
    else if (units.awaiting === 0) {
      const inStore = events.some((event) => event.kind === 'delivered' && event.dateBasis === 'in-store');
      [state, date] = [inStore ? 'in-store' : 'delivered', lastEventDate(events, 'delivered')];
    } else if (units.delivered > 0) [state, date] = ['partly-delivered', lastEventDate(events, 'delivered')];
    else if (units.shippedAwaiting) [state, date] = ['shipped', lastEventDate(events, 'shipped')];
    else [state, date] = ['awaiting', null];
    return { state, date };
  }

  /**
   * A lot's merchandise (`metalsMerchandise`, over its order as every figure reads it: the projection's skeleton once its
   * flagged lines are answered): its kept units' share by the ledger's unit split, earlier units first, as `bought` splits
   * a cost. Partial with `cost-unattributed` only when an order-level discount that could have reached the line stayed
   * unattributed, with `conflict` while its order is quarantined, as its cost, and with `date-unknown` while how many of
   * its units are kept is uncertain (`assignableDateUnknown`: a cancellation or return undated, year-inferred or
   * contradicting the other events as of today).
   */
  private merchandiseOf(entry: MetalsLedgerLine, units: MetalsLotUnits): MetalsMeasure<number> {
    const merchandise = metalsMerchandise(entry.order.order.skeleton, entry.order.order.components, entry.line.ordinal);
    const kept = units.delivered + units.awaiting;
    const keptMinor = metalsUnitSplit(merchandise.totalMinor, units.ordered).slice(0, kept).reduce((total, cents) => total + cents, 0);
    const reasons = new MetalsReasons();
    if (!merchandise.complete) reasons.add('cost-unattributed', entry.key);
    if (entry.order.quarantined) reasons.add('conflict', entry.order.order.key);
    if (units.assignableDateUnknown) reasons.add('date-unknown', entry.key);
    return metalsMeasure(keptMinor, reasons);
  }

  private purchaseSpot(metal: Metal, date: string): MetalsAdmissibleClose | null {
    return this.closeOn(metal, date);
  }

  purchases(metal: Metal, period: { from: string | null; to: string }): MetalsPurchases {
    const today = this.assignment(this.today);
    const salesByLot = new Map<string, Array<{ saleKey: string; agreedDate: string; units: number }>>();
    for (const cycle of today.cycles) {
      const list = salesByLot.get(cycle.lotKey) ?? [];
      list.push({ saleKey: cycle.saleKey, agreedDate: cycle.agreedDay, units: cycle.units });
      salesByLot.set(cycle.lotKey, list);
    }
    const purchases = this.lines(metal, 'buy')
      .filter((entry) => within(entry.order.order.date, period.from, period.to))
      .sort((a, b) => compareText(b.order.order.date, a.order.order.date) || compareText(a.key, b.key))
      // A lot ordered after today has no units as of today (`unitsAsOf` is null), and a period whose `to` is still to come
      // reaches it: it is in no list, as activity's bought doesn't count it (G1d).
      .flatMap((entry) => {
        const units = this.unitsAsOf(entry, this.today);
        return units === null ? [] : [{ entry, units }];
      })
      .map(({ entry, units }): MetalsPurchase => {
        const costReasons = new MetalsReasons();
        if (!entry.line.complete) costReasons.add('cost-unattributed', entry.key);
        if (entry.order.quarantined) costReasons.add('conflict', entry.order.order.key);
        const fine = this.fineOf(entry);
        const spot = this.purchaseSpot(metal, entry.order.order.date);
        const premium = fine === null || spot === null || !entry.line.complete ? null
          : metalsCycleBySpot({
            fineTroyOz: timesUnits(fine, entry.line.quantity), costMinor: entry.line.costMinor ?? 0, costComplete: true,
            proceedsMinor: 0, profitMinor: null, purchaseSpot: spot.close, saleSpot: null,
          }).premiumPaidPerOzMinor;
        return {
          key: entry.key,
          orderKey: entry.order.order.key,
          account: entry.order.account,
          channel: entry.order.order.channel,
          orderDate: entry.order.order.date,
          dateUnknown: units.dateUnknown,
          title: entry.line.title,
          productRef: entry.line.productRef,
          form: entry.line.form,
          seller: entry.line.seller,
          quantity: entry.line.quantity,
          units: { ordered: units.ordered, cancelled: units.cancelled, returned: units.returned, delivered: units.delivered, awaiting: units.awaiting },
          delivery: this.delivery(entry, units),
          costMinor: metalsMeasure(entry.line.costMinor ?? 0, costReasons),
          merchandiseMinor: this.merchandiseOf(entry, units),
          content: this.contentOf(entry),
          premiumPaidPerOzMinor: premium,
          purchaseSpot: spot ? { closeDate: spot.date } : null,
          funding: (entry.order.order.admission?.methods ?? []).map((method) => ({ kind: method.kind, network: method.network, amountMinor: method.amountMinor })),
          ...this.cardsOf(entry.order),
          refunds: entry.order.order.refunds.map((refund) => ({ amountMinor: refund.amountMinor, date: refund.date })),
          sales: salesByLot.get(entry.key) ?? [],
          quarantined: entry.order.quarantined,
        };
      });
    return { installed: true, metal, from: period.from, to: period.to, purchases, ...this.method() };
  }

  /** The dealer's implied spot of a sale line (metals-premium-text-v1), none, or a premium that can't be trusted. */
  dealerSpotOf(entry: MetalsLedgerLine): MetalsDealerSpot {
    return metalsDealerSpot(entry.line.sale?.premium, entry.line.unitPriceMinor, this.fineOf(entry));
  }

  sales(metal: Metal, period: { from: string | null; to: string }): MetalsSales {
    const today = this.assignment(this.today);
    const lineByKey = new Map(today.sales.map((line) => [line.key, line]));
    const cyclesBySale = new Map<string, typeof today.cycles>();
    for (const cycle of today.cycles) {
      const list = cyclesBySale.get(cycle.saleKey) ?? [];
      list.push(cycle);
      cyclesBySale.set(cycle.saleKey, list);
    }
    const sales = this.lines(metal, 'sell')
      .filter((entry) => within(entry.order.order.date, period.from, period.to))
      .sort((a, b) => compareText(b.order.order.tradeMoment ?? '', a.order.order.tradeMoment ?? '') || compareText(a.key, b.key))
      .map((entry): MetalsSale => {
        const line = lineByKey.get(entry.key);
        const dealer = this.dealerSpotOf(entry);
        const close = this.closeOn(metal, entry.order.order.date);
        const saleSpot: MetalsSaleSpot | null = dealer.kind === 'implied' ? { basis: 'dealer-implied' }
          : close ? { basis: 'close-proxy', closeDate: close.date } : null;
        const saleSpotValue = dealer.kind === 'implied' ? dealer.spot : close?.close ?? null;
        const cycles = (cyclesBySale.get(entry.key) ?? []).map((cycle): MetalsSaleCycle => {
          const lot = this.graph.lineByKey.get(cycle.lotKey)!;
          const purchaseSpot = this.purchaseSpot(metal, cycle.orderDate);
          const split = metalsCycleBySpot({
            fineTroyOz: cycle.fineTroyOz, costMinor: cycle.costMinor, costComplete: cycle.costComplete, proceedsMinor: cycle.proceedsMinor,
            profitMinor: cycle.profitMinor, purchaseSpot: purchaseSpot?.close ?? null, saleSpot: saleSpotValue,
          });
          return {
            lotKey: cycle.lotKey,
            orderKey: lot.order.order.key,
            units: cycle.units,
            troyOz: metalsTroyOz(cycle.fineTroyOz),
            orderDate: cycle.orderDate,
            account: lot.order.account,
            daysFromOrderToSale: cycle.daysHeld,
            costMinor: cycle.costComplete ? cycle.costMinor : null,
            proceedsMinor: cycle.proceedsMinor,
            profitMinor: cycle.profitMinor,
            premiumPaidPerOzMinor: split.premiumPaidPerOzMinor,
            salePremiumPerOzMinor: split.salePremiumPerOzMinor,
            fromSpotMinor: split.fromSpotMinor,
            fromPremiumsMinor: split.fromPremiumsMinor,
            purchaseSpot: purchaseSpot ? { closeDate: purchaseSpot.date } : null,
            lotQuarantined: lot.order.quarantined,
          };
        });
        const net = entry.line.netMinor ?? 0;
        // Its cost basis and profit or loss: over its cycles with a complete cost (unknown when none), with every reason that
        // could change them (`saleReasons`). A cancelled sale realized nothing, unless its own contradiction says otherwise.
        // An open held record of its own key (a later import couldn't read it) leaves its state, and so either, unknown (H4).
        const counted = (cyclesBySale.get(entry.key) ?? []).filter((cycle) => cycle.costComplete);
        const reasons = line ? this.saleReasons(line, metal, today)
          : entry.order.quarantined ? new MetalsReasons().add('conflict', entry.order.order.key) : new MetalsReasons();
        for (const hold of this.graph.openHolds) if (hold.key === entry.order.order.key) reasons.add('source-held', holdRecord(hold));
        const costValue = line === undefined ? 0 : counted.length === 0 ? null : counted.reduce((total, cycle) => total + cycle.costMinor, 0);
        const profitValue = line === undefined ? 0 : counted.length === 0 ? null : counted.reduce((total, cycle) => total + (cycle.profitMinor ?? 0), 0);
        // Under the owner's estimate switch its units with no recorded purchase add their estimated part (a label: never a
        // cycle), and the line says both parts.
        const estimated = line === undefined ? undefined : this.estimateOf(line, today);
        const saleEstimate = this.estimatesCostOf(metal) && line !== undefined && line.unmatchedUnits > 0
          ? { estimate: estimated === undefined ? null : this.saleEstimate(estimated, costValue, profitValue) } : {};
        return {
          key: entry.key,
          orderKey: entry.order.order.key,
          account: entry.order.account,
          agreedDate: entry.order.order.date,
          tradeMoment: entry.order.order.tradeMoment ?? '',
          status: entry.order.order.status ?? 'agreed',
          inspection: entry.line.sale?.inspection ?? null,
          program: entry.line.sale?.program ?? null,
          premium: entry.line.sale?.premium ?? null,
          title: entry.line.title,
          productRef: entry.line.productRef,
          form: entry.line.form,
          quantity: entry.line.quantity,
          grossMinor: entry.line.amountMinor,
          feesMinor: entry.line.amountMinor - net,
          netMinor: net,
          content: this.contentOf(entry),
          matched: { units: line?.matchedUnits ?? 0, netMinor: line?.matchedNetMinor ?? 0 },
          unmatched: {
            units: line?.unmatchedUnits ?? 0, netMinor: line?.unmatchedNetMinor ?? 0,
            reasons: line && line.unmatchedUnits > 0 ? this.unmatchedParts(entry.key) : [],
          },
          known: line?.known ?? false,
          costMinor: metalsMeasure(estimated === undefined ? costValue : (costValue ?? 0) + estimated.costMinor, reasons),
          profitMinor: metalsMeasure(estimated === undefined ? profitValue : (profitValue ?? 0) + estimated.profitMinor, reasons),
          dateUnknown: (line?.dateUnknownLots.length ?? 0) > 0,
          // Another contradicted order could change which purchases it took (its own contradiction is `quarantined`):
          // its measures carry conflict exactly when this or `quarantined` is true.
          purchaseConflict: line !== undefined && this.quarantinedKeys(metal, ['buy', 'sell']).some((key) => key !== entry.order.order.key),
          payouts: this.payoutsOf(entry.order),
          cycles,
          saleSpot,
          premiumDisagreement: dealer.kind === 'premium-disagreement',
          quarantined: entry.order.quarantined,
          ...saleEstimate,
        };
      });
    return { installed: true, metal, from: period.from, to: period.to, sales, ...this.method(), ...this.estimateMethod() };
  }

  /** A sale line's estimate as the sales list shows it, beside its recorded parts (its cycles with a complete cost). */
  private saleEstimate(estimate: MetalsEstimateLine, recordedCost: number | null, recordedProfit: number | null): MetalsSaleEstimate {
    const lot = this.graph.lineByKey.get(estimate.lotKey)!;
    return {
      units: estimate.units,
      unitCostMinor: estimate.unitCostMinor,
      costMinor: estimate.costMinor,
      proceedsMinor: estimate.proceedsMinor,
      profitMinor: estimate.profitMinor,
      recorded: { costMinor: recordedCost, profitMinor: recordedProfit },
      from: {
        lotKey: estimate.lotKey, orderKey: estimate.orderKey, orderDate: estimate.orderDate, account: lot.order.account,
        daysFromOrderToSale: estimate.daysFromOrderToSale,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Timeline
  // -------------------------------------------------------------------------

  /** The months a timeline lists by default: from the metal's first order or agreed month through this month. */
  defaultMonths(metal: Metal): { fromMonth: string; toMonth: string } {
    const dates = [...this.lines(metal, 'buy'), ...this.lines(metal, 'sell')].map((entry) => entry.order.order.date).sort(compareText);
    return { fromMonth: (dates[0] ?? this.today).slice(0, 7), toMonth: this.today.slice(0, 7) };
  }

  timeline(metal: Metal, fromMonth: string, toMonth: string): MetalsTimeline {
    const months: MetalsTimelineMonth[] = [];
    const complete = this.knownCoverage.filter((entry) => entry.complete);
    for (let month = fromMonth; month <= toMonth; month = nextMonth(month)) {
      const first = `${month}-01`;
      if (first > this.today) break;
      const last = lastDayOf(month);
      const endDate = last < this.today ? last : this.today;
      const recorded = complete.some((entry) => entry.from <= endDate && entry.to >= first);
      if (!recorded) {
        const gap = new MetalsReasons().add('not-covered', month);
        months.push({
          month, endDate, recorded: false, troyOz: metalsMeasure<MetalsTroyOz>(null, gap), costMinor: metalsMeasure<number>(null, gap),
          valueMinor: metalsMeasure<number>(null, gap), closeDate: null,
        });
        continue;
      }
      const { holdings } = this.holdings(metal, endDate);
      months.push({
        month,
        endDate,
        recorded: true,
        troyOz: holdings.troyOz,
        costMinor: holdings.costMinor,
        valueMinor: holdings.valueMinor,
        closeDate: this.closeOn(metal, endDate)?.date ?? null,
      });
    }
    return { installed: true, metal, months, ...this.method() };
  }

  // -------------------------------------------------------------------------
  // Closes
  // -------------------------------------------------------------------------

  /**
   * `GET /metals/closes`: the admissible closes (`closes`), dated in the period, oldest first, each as a price's `close`
   * gives it. Only what is stored: nothing here fetches. Its route gives these views the stored closes' screen whether or
   * not this Holdr fetches: the one valuation reads while it does (ROOT O110).
   */
  dailyCloses(metal: Metal, period: { from: string | null; to: string }): MetalsCloses {
    const closes = this.closes(metal).filter((entry) => within(entry.date, period.from, period.to))
      .map((entry) => ({ date: entry.date, close: plainDecimal(entry.close) }));
    return { installed: true, metal, fetching: this.options.fetching, closes };
  }

  // -------------------------------------------------------------------------
  // Products and the owner's content decisions
  // -------------------------------------------------------------------------

  /** What a line's title suggests per ordered unit (§4.4.1 step 7): a proposal only, which counts for nothing. */
  static proposal(entry: MetalsLedgerLine): Rational | null {
    const { line } = entry;
    if (line.metal === null || line.statedMass === null || line.pack !== 'single') return null;
    const mass = parseRational(line.statedMass.value);
    if (mass === null || mass.num <= 0n) return null;
    const troy = troyOunces(mass, line.statedMass.unit === 'oz' ? 'ozt' : line.statedMass.unit);
    if (line.massBasis === 'gross') {
      const purity = line.purity ? readRational(line.purity.value) : null;
      return purity !== null && purity.num > 0n && purity.num <= purity.den ? multiply(troy, purity) : null;
    }
    return troy;
  }

  /** The lines a confirmation scope covers: a product's `single` lines of its ref and fingerprint, or one line. */
  scopeLines(scope: { kind: 'product'; ref: string; fingerprint: string } | { kind: 'lot'; lotKey: string }): MetalsLedgerLine[] {
    if (scope.kind === 'lot') {
      const entry = this.graph.lineByKey.get(scope.lotKey);
      return entry ? [entry] : [];
    }
    return this.graph.lines.filter((entry) => entry.scope.kind === 'product' && entry.scope.ref === scope.ref
      && entry.scope.fingerprint === scope.fingerprint);
  }

  liveDecisionFor(scope: { kind: 'product'; ref: string; fingerprint: string } | { kind: 'lot'; lotKey: string }): MetalsDecisionInput | null {
    return this.graph.decisions.find((decision) => (scope.kind === 'product'
      ? decision.scope === 'product' && decision.productRef === scope.ref && decision.fingerprint === scope.fingerprint
      : decision.scope === 'lot' && decision.lotKey === scope.lotKey)) ?? null;
  }

  productRows(metal: Metal): MetalsProduct[] {
    const groups = new Map<string, MetalsLedgerLine[]>();
    for (const entry of this.graph.lines) {
      if (entry.line.metal !== metal) continue;
      const key = entry.scope.kind === 'product' ? `product\u0000${entry.scope.ref}\u0000${entry.scope.fingerprint}` : `lot\u0000${entry.key}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    const rows: MetalsProduct[] = [];
    for (const entries of groups.values()) {
      const [first] = entries;
      const scope = first.scope.kind === 'product'
        ? { kind: 'product' as const, ref: first.scope.ref, fingerprint: first.scope.fingerprint }
        : { kind: 'lot' as const, lotKey: first.key, evidenceDigest: first.order.digest, why: first.scope.why };
      const held = entries.find((entry) => !entry.content.known);
      const known = entries.find((entry) => entry.content.known);
      const answering = entries.map((entry) => entry.decision).find((decision): decision is MetalsDecisionInput => decision !== null) ?? null;
      const proposal = MetalsViews.proposal(first);
      rows.push({
        scope,
        source: first.order.source,
        titles: [...new Set(entries.map((entry) => entry.line.title).filter((title): title is string => title !== null))].slice(0, 5),
        stated: {
          metal: first.line.metal,
          form: first.line.form,
          mass: first.line.statedMass,
          purity: first.line.purity?.text ?? null,
          massBasis: first.line.massBasis,
          design: first.line.design,
        },
        pack: first.line.pack,
        packCount: null,
        proposal: proposal === null || first.line.metal === null ? null : { metal: first.line.metal, troyOzPerUnit: metalsTroyOz(proposal) },
        lots: entries.filter((entry) => entry.side === 'buy').length,
        saleLines: entries.filter((entry) => entry.side === 'sell').length,
        units: entries.reduce((total, entry) => total + entry.line.quantity, 0),
        hold: held && !held.content.known ? held.content.hold : null,
        decision: answering === null ? null : {
          id: answering.id, metal: answering.metal ?? metal, troyOzPerUnit: metalsTroyOz(readRational(answering.troyOzPerUnit) ?? ZERO),
          decidedAt: answering.decidedAt,
        },
        drift: entries.some((entry) => entry.drift),
        basis: known && known.content.known ? known.content.basis : null,
      });
    }
    return rows.sort((a, b) => Number(b.hold !== null) - Number(a.hold !== null) || compareText(a.source, b.source)
      || compareText(a.titles[0] ?? '', b.titles[0] ?? '') || compareText(JSON.stringify(a.scope), JSON.stringify(b.scope)));
  }

  products(metal: Metal): MetalsProducts {
    return { installed: true, metal, products: this.productRows(metal) };
  }

  // -------------------------------------------------------------------------
  // Funding (P1)
  // -------------------------------------------------------------------------

  funding(period: { from: string | null; to: string }): MetalsFunding {
    const purchases: MetalsFundingPurchase[] = [];
    const sales: MetalsFunding['sales'] = [];
    const receipts = metalsReceiptCharges(this.graph.cardGraph, this.graph.chargeOrders);
    const metalsOf = (order: MetalsLedgerOrder) => [...new Set(order.order.lines.map((line) => line.metal).filter((metal): metal is Metal => metal !== null))].sort();
    /** An order's lines of unknown metal, which `metalsOf` can't name: counted, so a row never lists only its known metals (G1d). */
    const metalUnknownLinesOf = (order: MetalsLedgerOrder) => order.order.lines.filter((line) => line.metal === null).length;
    // An order held for metals, or one that left the ledger (every line answered not bullion), is in no funding row, and
    // its payouts' candidate deposits are listed nowhere.
    const ordered = [...this.graph.orders.values()].filter((entry) => !entry.heldForMetals && !entry.leftLedger)
      .sort((a, b) => compareText(b.order.date, a.order.date) || compareText(a.order.key, b.order.key));
    for (const entry of ordered) {
      if (!within(entry.order.date, period.from, period.to)) continue;
      if (entry.order.side === 'buy') {
        const kinds = new Map<MetalsFundingPurchase['byKind'][number]['kind'], { methods: number; amountMinor: number | null }>();
        let stated = 0;
        let allStated = true;
        for (const method of entry.order.admission?.methods ?? []) {
          const kind = method.kind === 'card' || method.kind === 'card-refund' ? 'card'
            : method.kind === 'shop-card' || method.kind === 'gift-card' || method.kind === 'store-balance' ? method.kind : 'other';
          const bucket = kinds.get(kind) ?? { methods: 0, amountMinor: 0 };
          bucket.methods += 1;
          if (method.amountMinor === null) {
            bucket.amountMinor = null;
            allStated = false;
          } else {
            if (bucket.amountMinor !== null) bucket.amountMinor += method.amountMinor;
            stated += method.amountMinor;
          }
          kinds.set(kind, bucket);
        }
        if (allStated && stated !== entry.order.fullPriceMinor) {
          kinds.set('not-stated', { methods: 0, amountMinor: entry.order.fullPriceMinor - stated });
        }
        purchases.push({
          orderKey: entry.order.key,
          account: entry.account,
          orderDate: entry.order.date,
          fullPriceMinor: entry.order.fullPriceMinor,
          metals: metalsOf(entry),
          metalUnknownLines: metalUnknownLinesOf(entry),
          allMetal: allMetalOrder(entry.order.skeleton),
          quarantined: entry.quarantined,
          ...this.cardsOf(entry),
          receiptCharges: receipts.filter((charge) => charge.orderKey === entry.order.key)
            .map((charge) => ({ rowId: charge.rowId, evidenceClass: charge.evidenceClass, metals: [...charge.metals] })),
          refunds: entry.order.refunds.map((refund) => ({ amountMinor: refund.amountMinor, date: refund.date })),
          byKind: [...kinds.entries()].map(([kind, bucket]) => ({ kind, ...bucket })),
        });
      } else {
        sales.push({
          orderKey: entry.order.key,
          account: entry.account,
          agreedDate: entry.order.date,
          netMinor: entry.order.fullPriceMinor,
          metals: metalsOf(entry),
          metalUnknownLines: metalUnknownLinesOf(entry),
          quarantined: entry.quarantined,
          payouts: this.payoutsOf(entry),
        });
      }
    }
    const deposits: MetalsFunding['deposits'] = [];
    for (const [payoutKey, link] of this.graph.depositLinks) {
      const sale = this.graph.orders.get(link.saleOrderKey);
      if (link.rowId === null || sale === undefined || sale.heldForMetals || sale.leftLedger) continue;
      const row = this.graph.checkingRows.get(link.rowId);
      if (!row || !within(row.date, period.from, period.to)) continue;
      deposits.push({
        rowId: link.rowId, saleKey: link.saleOrderKey, payoutKey, state: link.state, proof: link.proof,
        classification: link.proof ? 'asset-sale-proceeds' : null,
      });
    }
    deposits.sort((a, b) => compareText(a.rowId, b.rowId) || compareText(a.payoutKey, b.payoutKey));
    return { installed: true, from: period.from, to: period.to, purchases, sales, deposits };
  }
}

export function nextMonth(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
}

/** The month `count` months after `month` (YYYY-MM), or before it when `count` is negative. */
export function addMonths(month: string, count: number): string {
  const [year, value] = month.split('-').map(Number);
  const index = year * 12 + value - 1 + count;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function lastDayOf(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
}

/** Months from `from` to `to`, both YYYY-MM, inclusive. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}
