import type { Metal, MetalsCompletenessReason, MetalsMeasure, MetalsOverview, MetalsPurchases, MetalsTroyOz } from './goldApi';
import {
  combined,
  dateText,
  fungibleFor,
  metalName,
  metalTitle,
  ownerReasons,
  plural,
  profitCoverageText,
  profitFullyKnown,
  reasonText,
  signedUsd,
  spotShown,
  troyOzNumber,
  usd,
} from './goldText';

/**
 * The page's totals: Alex's three questions (how much bought, how much sold, how much made or lost), over all recorded
 * history to one as-of date, per metal and for the metals together. The numbers follow 5b01e72f's ruling v1 (sha
 * 3c8f494a), the words Astra's copy ruling. Pure: they read only what the metals reads serve, and never build a second
 * coverage test of their own from the served counts.
 *
 * - Bought: the all-in recorded cost of purchases kept or on the way, by order date (`activity.bought`), however paid.
 * - Sold: net sale proceeds after fees, by the day agreed (`activity.sold`): never payouts or deposits.
 * - Profit or loss, only when every gate holds, and never a partial figure:
 *   (a) no sold unit without a recorded purchase; (b) the served proof that the relevant purchase and sale history is
 *   complete (G3's coverage gaps; until it is served, the figure is unavailable); (c) the realized result complete, with
 *   no reason; and no purchase or sale whose metal is unknown.
 *   - Prices off: the realized result on recorded sales (`activity.profit`), costs assigned oldest first (across all forms
 *     where the owner's fungible policy names the metal).
 *   - Values shown: that plus the gain on delivered holdings at the dated spot, units on the way carried at what was paid
 *     (`activity.profit` + `holdings.gain`), once every figure behind it is complete, no content is unknown, and no
 *     cancelled or returned purchase is left whose refund the page can't settle. Otherwise the realized result alone.
 */

/**
 * Gate (b) as the page reads it, for one metal. `sales` is that metal's own scope, used for the realized result: buy
 * kinds through its last included sale, sell kinds through the as-of day, and `no-sales`, never a zero, when it has none.
 * `asOf` is the household-wide scope, used for the estimate and for Bought and Sold.
 *
 * G3 serves both in `MetalsOverview.coverageProof` (card cross-check design v3 §6.7; under review, not final). When it
 * is served (PR-E), an adapter maps `sales[]`'s entry for the metal and `asOfScope` onto this. It says each typed gap in
 * words (Astra owns them), combines the metals only from reads of one `snapshot`, and holds the served `totals`
 * (`realized`, `estimate`, `metalUnknown`) to the same verdicts. Null until then: every figure it gates is unavailable.
 */
export type GoldCoverageState = 'complete' | 'incomplete' | 'no-sales' | 'unavailable';
export interface GoldCoverageScope {
  state: GoldCoverageState;
  /** Each gap in words; empty only when complete (or no sales). */
  gaps: readonly string[];
}
export interface GoldCoverageProof {
  sales: GoldCoverageScope;
  asOf: GoldCoverageScope;
}

/** The result's labels each say it is before rewards (ROOT, from the owner's reaction): it never reads as a final loss. */
export const TOTALS_RESULT_LABEL = 'Profit or loss, before rewards';
export const TOTALS_SALES_LABEL = 'Profit or loss on recorded sales, before rewards';
export const TOTALS_CHIPS_NOTE = 'Choose a period below. The totals above stay all time.';
export const TOTALS_UNAVAILABLE = 'Profit or loss unavailable';
export const TOTALS_NOT_COVERED = 'Profit or loss unavailable: recorded purchases do not cover the recorded sales.';
export const TOTALS_UNVERIFIED = 'Purchase history is incomplete or unverified.';
/** No coverage proof served, or none computable: nothing is presumed about other dealers or the owner's answers. */
export const TOTALS_COVERAGE_UNVERIFIABLE = 'Purchase coverage could not be verified.';
/** The action after an unavailable figure: opens Details on where the figures come from. */
export const TOTALS_REVIEW_COVERAGE = 'Review coverage';
export const TOTALS_BOUGHT_UNVERIFIED = 'Recorded so far; full purchase history has not been verified.';
export const TOTALS_SOLD_UNVERIFIED = 'Recorded so far; full sale history has not been verified.';
export const TOTALS_ESTIMATE_QUALIFIER = 'Includes estimated value of what you still hold.';
export const TOTALS_ESTIMATE_BASIS = 'Sale proceeds + estimated value still held − purchase costs.';
export const TOTALS_ESTIMATE_BASIS_CARRY = 'Sale proceeds + delivered holdings at spot + purchases on the way at cost − purchase costs.';
/** The estimate with no delivered holdings left and no usable close (appendix choice 4; Astra's words): no price is used. */
export const TOTALS_NO_PRICE_NEEDED = 'No delivered holdings remain in these records, so no market price is needed for this result.';
export const TOTALS_BASIS_ON_THE_WAY_AT_COST = 'Sale proceeds + purchases on the way at cost − purchase costs.';
export const TOTALS_SALES_BASIS = 'Sale proceeds minus the cost assigned to those sales.';
export const TOTALS_SALES_METHOD = 'Costs assigned oldest first; this does not identify which bars or coins were sold.';
/** The method where the owner's fungible policy names the metal (`MetalsAssignmentMethod`). */
export const TOTALS_SALES_METHOD_FUNGIBLE = 'Costs assigned oldest first across all forms (your rule); this does not identify which bars '
  + 'or coins were sold.';
export const TOTALS_HELD_OFF = 'Holdings are not valued while prices are off; their gain or loss is not included.';
export const TOTALS_BEFORE_REWARDS = 'Before rewards';
export const TOTALS_NO_SALES = 'No sales recorded.';
export const TOTALS_NO_SALES_OFF = 'No sales recorded. Holdings are not valued while prices are off.';
/** The metals together with no sale recorded in any of them: never a $0 answer while holdings aren't in it. */
export const TOTALS_COMBINED_NO_SALES = 'No sales recorded. Holdings are not included in this result.';
export const TOTALS_NEEDS_ALL_TIME = 'These totals need all recorded history.';
export const TOTALS_COMBINED_UNAVAILABLE = 'Combined profit or loss unavailable';
export const TOTALS_HELD_EXCLUDED = 'What you still hold isn’t included in this figure.';
/**
 * Why holdings are left out when a figure the estimate needs isn't complete and gives no reason (never served so; fail
 * closed: G1d, PR-R), said only when no specific reason exists (Astra's R5 words).
 */
export const TOTALS_HELD_INCOMPLETE = 'Holdings are not included in this result because required information is incomplete.';
export const TOTALS_INCLUDES = [
  'Bought (kept or on the way): what each purchase cost all-in (the item, its own shipping and fees, and its share of the order’s tax and '
    + 'shipping, less discounts and coupons), however it was paid: card, Shop Card, gift card or other. Only purchases kept '
    + 'or on the way count; cancelled and returned ones are listed under Details, not here.',
  'Sold: what each sale brings in after the dealer’s fees and insured shipping, by the day agreed. Sale proceeds aren’t '
    + 'bank deposits; payouts are listed under Details.',
  'Profit or loss excludes card rewards and Costco Executive rewards.',
] as const;

/**
 * The totals' limitations, said once (Astra's review of b558ebcc): beside each figure only its limitation in short; every
 * reason in full under one fold, each with the figures it affects.
 */
export const TOTALS_WHY = 'Why these totals are incomplete';
export const TOTALS_RECORDED_SO_FAR = 'Recorded so far';
export const TOTALS_HISTORY_UNVERIFIED = 'history unverified';
export const TOTALS_AFFECTS = 'Affects';
/** The figures a reason is said against, by their labels ("Bought" as metalsApi defines it: kept or on the way; Astra). */
export const TOTALS_FIGURES = { bought: 'Bought (kept or on the way)', sold: 'Sold', result: 'Profit or loss' } as const;

/** One of the totals' numbers: its figure (or the words that stand for it), its sub-line, and its limitations. */
export interface GoldTotalsRow {
  figure: string;
  /** The measure's state; `none` when nothing is recorded. */
  state: 'complete' | 'partial' | 'unknown' | 'none';
  sub: string;
  /** Its limitation in short, said beside it ("Partial · history unverified"); null when it has none. */
  short: string | null;
  /** The history behind it isn't proven complete. */
  unverified: boolean;
  /** Each of its limitations in full, said under the fold with the figures each affects. */
  limits: string[];
}

/** A reason the totals are incomplete, said once, with the figures it affects. */
export interface GoldTotalsReason {
  text: string;
  figures: string[];
}

/**
 * The third number: an estimate including what is still held, the realized result on recorded sales (`figure` null when
 * nothing was sold: its lines say so), or unavailable with why and the one action that helps (where the figures come
 * from, when the history isn't proven or doesn't cover the sales; otherwise what waits to be checked). Unavailable, its
 * `lead` is the principal reason, said under its title (null when the title says it); every reason is in `lines`.
 */
export type GoldTotalsResult =
  | { kind: 'estimate'; valueMinor: number; figure: string; lines: string[]; unpriced?: true }
  | { kind: 'sales'; valueMinor: number; figure: string | null; lines: string[] }
  | { kind: 'unavailable'; title: string; lead: string | null; lines: string[]; action: 'coverage' | 'review' };

export interface GoldTotals {
  metal: Metal;
  heading: string;
  asOf: string;
  bought: GoldTotalsRow;
  sold: GoldTotalsRow;
  /** The third number's label; null when its refusal already names it ("Profit or loss unavailable: …"). */
  resultLabel: string | null;
  result: GoldTotalsResult;
  /** Every reason the figures above are incomplete, once each, in the order the figures say them. */
  why: GoldTotalsReason[];
}

/** The third number's label: what it is, unless its refusal sentence says so itself. */
export function resultLabelOf(result: GoldTotalsResult): string | null {
  if (result.kind === 'sales') return TOTALS_SALES_LABEL;
  if (result.kind === 'unavailable' && /profit or loss unavailable/i.test(result.title)) return null;
  return TOTALS_RESULT_LABEL;
}

/** One metal's all-time reads for its totals. `purchases` is read only while values show (the estimate's check). */
export interface GoldTotalsInput {
  overview: MetalsOverview;
  purchases: MetalsPurchases | null;
  /** The purchases read failed (values showed, so it was read). */
  purchasesError: boolean;
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

const reasonsText = (reasons: readonly MetalsCompletenessReason[], overview: MetalsOverview, skip: readonly string[] = []) => {
  const owner = ownerReasons(overview);
  return [...new Set(reasons.filter((reason) => !skip.includes(reason.code))
    .map((reason) => owner[reason.code] ?? reasonText(reason, overview.metal)))];
};

/** Troy ounces in a sub-line: never unqualified while partial, never a number while unknown. */
function ouncesPart(measure: MetalsMeasure<MetalsTroyOz>): string {
  if (measure.value === null) return 'troy oz unknown';
  return measure.state === 'complete' ? `${measure.value.display} troy oz` : `${measure.value.display} troy oz confirmed so far`;
}

function moneyRow(measure: MetalsMeasure<number>, count: number, none: string): Pick<GoldTotalsRow, 'figure' | 'state'> {
  if (count === 0 && measure.state === 'complete') return { figure: none, state: 'none' };
  return { figure: measure.value === null ? '—' : usd(measure.value), state: measure.state };
}

const historyProven = (proof: GoldCoverageProof | null) => proof?.asOf.state === 'complete';

/** Recorded purchases or sales whose metal is unresolved: outside every metal's figure, said beside each one they miss. */
export function unresolvedMetalLine(side: 'purchase' | 'sale', count: number): string {
  return `Not included: ${plural(count, `recorded ${side}`, `recorded ${side}s`)} whose metal is unresolved.`;
}

/** The records a figure leaves out, by count, in short: "1 sale not included". */
export function leftOutShort(side: 'purchase' | 'sale', count: number): string | null {
  return count > 0 ? `${plural(count, side, `${side}s`)} not included` : null;
}

/**
 * A figure's limitation in short, said beside it: its state ("Partial", "Unknown", or "Recorded so far" for a figure
 * complete as recorded), the records it leaves out by count, and "history unverified" while the history behind it isn't
 * proven complete. Null when it has none of them.
 */
export function shortLimit(state: GoldTotalsRow['state'], leftOut: string | null, unverified: boolean): string | null {
  const word = state === 'partial' ? 'Partial' : state === 'unknown' ? 'Unknown' : null;
  if (word === null && leftOut === null && !unverified) return null;
  return [word ?? TOTALS_RECORDED_SO_FAR, leftOut, unverified ? TOTALS_HISTORY_UNVERIFIED : null]
    .filter((part): part is string => part !== null).join(' · ');
}

export function boughtRow(overview: MetalsOverview, proof: GoldCoverageProof | null): GoldTotalsRow {
  const { bought } = overview.activity;
  const limits = reasonsText(combined(bought.costMinor, bought.troyOz).reasons, overview);
  if (overview.metalUnknown.lots > 0) limits.push(unresolvedMetalLine('purchase', overview.metalUnknown.lots));
  const unverified = !historyProven(proof);
  if (unverified) limits.push(TOTALS_BOUGHT_UNVERIFIED);
  const money = moneyRow(bought.costMinor, bought.lots, 'No recorded purchases');
  return {
    ...money,
    sub: `${ouncesPart(bought.troyOz)} · ${plural(bought.lots, 'recorded purchase', 'recorded purchases')}`,
    short: shortLimit(money.state, leftOutShort('purchase', overview.metalUnknown.lots), unverified),
    unverified,
    limits,
  };
}

export function soldRow(overview: MetalsOverview, proof: GoldCoverageProof | null): GoldTotalsRow {
  const { sold } = overview.activity;
  const limits = reasonsText(combined(sold.netMinor, sold.troyOz).reasons, overview);
  if (overview.metalUnknown.sales > 0) limits.push(unresolvedMetalLine('sale', overview.metalUnknown.sales));
  const unverified = !historyProven(proof);
  if (unverified) limits.push(TOTALS_SOLD_UNVERIFIED);
  const money = moneyRow(sold.netMinor, sold.lines, 'No sales recorded');
  return {
    ...money,
    sub: `${ouncesPart(sold.troyOz)} · ${plural(sold.lines, 'recorded sale', 'recorded sales')} · proceeds after fees`,
    short: shortLimit(money.state, leftOutShort('sale', overview.metalUnknown.sales), unverified),
    unverified,
    limits,
  };
}

/**
 * Every reason the totals are incomplete, said once, with the figures it affects: Bought's and Sold's limitations, and
 * the reasons the profit or loss is unavailable (a figure's own basis lines stay beside it, never folded away).
 */
export function totalsWhy(bought: GoldTotalsRow, sold: GoldTotalsRow, result: GoldTotalsResult): GoldTotalsReason[] {
  const figuresOf = new Map<string, string[]>();
  const add = (texts: readonly string[], figure: string) => {
    for (const text of texts) {
      const figures = figuresOf.get(text) ?? [];
      if (!figures.includes(figure)) figures.push(figure);
      figuresOf.set(text, figures);
    }
  };
  add(bought.limits, TOTALS_FIGURES.bought);
  add(sold.limits, TOTALS_FIGURES.sold);
  // An unavailable result's reasons; when its title is the reason (recorded purchases don't cover the sales), that too:
  // in view as the title and in the fold, so the fold alone holds every reason.
  if (result.kind === 'unavailable') {
    add(result.title === TOTALS_NOT_COVERED ? [result.title, ...result.lines] : result.lines, TOTALS_FIGURES.result);
  }
  return [...figuresOf].map(([text, figures]) => ({ text, figures }));
}

const metalUnknownCount = (overview: MetalsOverview) => overview.metalUnknown.lots + overview.metalUnknown.sales;

export function metalUnknownText(count: number): string {
  return count === 1
    ? '1 purchase or sale has an unresolved metal, so it belongs to no one metal’s totals'
    : `${count} purchases or sales have an unresolved metal, so they belong to no one metal’s totals`;
}

/**
 * A scope's gate (b) in words: nothing when it is proven (or there are no sales to prove), else its gaps. Unserved or
 * not computable, only that coverage couldn't be verified: nothing about other dealers or the owner's answers is
 * presumed (Astra: "whether you bought elsewhere" is said only when a served state says that answer is pending).
 */
function scopeLines(scope: GoldCoverageScope | null): string[] {
  if (scope === null || scope.state === 'unavailable') return [TOTALS_COVERAGE_UNVERIFIABLE];
  if (scope.state === 'complete' || scope.state === 'no-sales') return [];
  return scope.gaps.length > 0 ? [...scope.gaps] : [TOTALS_UNVERIFIED];
}

/** What blocks the realized result on recorded sales (gates a, b and c, and metal unknown); empty when nothing does. */
export function salesResultBlocks(overview: MetalsOverview, proof: GoldCoverageProof | null): { notCovered: boolean; lines: string[] } {
  const { sold, profit } = overview.activity;
  const notCovered = sold.unmatched.units > 0;
  const lines: string[] = [...scopeLines(proof?.sales ?? null)];
  if (profit.valueMinor.state !== 'complete') {
    lines.push(...reasonsText(profit.valueMinor.reasons, overview, notCovered ? ['unmatched-sales'] : []));
  }
  const { coverage } = profit;
  if (!profitFullyKnown(coverage) && sold.lines > 0) lines.push(sentence(profitCoverageText(coverage, profit.estimate)));
  const unknownMetal = metalUnknownCount(overview);
  if (unknownMetal > 0) lines.push(sentence(metalUnknownText(unknownMetal)));
  return { notCovered, lines: [...new Set(lines)] };
}

/** Delivered holdings proven to be none: their value is zero without a price (5b01e72f §3). */
function provenNoneHeld(overview: MetalsOverview): boolean {
  const { troyOz, costMinor, units } = overview.holdings;
  return troyOz.state === 'complete' && troyOz.value !== null && troyOzNumber(troyOz.value) === 0 && units.held === 0
    && costMinor.state === 'complete' && costMinor.value === 0;
}

/**
 * The estimate needs no market price (5b01e72f's appendix, choice 4; C2-H4 for a metal never sold): this Holdr fetches
 * closes but has no usable one yet, delivered holdings are proven none, and there is something to count (sales recorded,
 * or units on the way at what was paid). Prices off stays apart: nothing is valued while they are. With no sale and
 * nothing on the way there is no figure at all (Astra: the no-sales words stay).
 */
export function estimateWithoutPrice(overview: MetalsOverview): boolean {
  const { activity: { sold }, holdings } = overview;
  return spotShown(overview.price) === 'no-price-yet' && provenNoneHeld(overview)
    && (sold.lines > 0 || holdings.units.awaitingUnassigned > 0);
}

/** Whether the totals read a metal's purchases (the estimate's check of cancelled and returned ones): whenever an estimate can stand. */
export function totalsReadsPurchases(overview: MetalsOverview): boolean {
  return spotShown(overview.price) === 'shown' || estimateWithoutPrice(overview);
}

/**
 * What blocks the estimate that includes holdings, beyond the realized result's own gates: the as-of scope's gate (b) in
 * sentences, the rest as reasons to join into one sentence, and `incomplete` when a figure it needs isn't complete and
 * gives no reason. All empty (and `incomplete` false) when nothing blocks it.
 */
export function estimateBlocks(input: GoldTotalsInput, proof: GoldCoverageProof | null): { scope: string[]; reasons: string[]; incomplete: boolean } {
  const { overview, purchases, purchasesError } = input;
  const { activity: { bought, sold }, holdings } = overview;
  const scope = scopeLines(proof?.asOf ?? null);
  const lines: string[] = [];
  const unknownContent = holdings.contentUnknown.lots + holdings.contentUnknown.sales;
  if (unknownContent > 0) {
    lines.push(ownerReasons(overview)['content-unknown']
      ?? reasonText({ code: 'content-unknown', records: unknownContent }, overview.metal));
  }
  // A measure that isn't complete blocks the estimate with its reasons, or, if it gives none, as incomplete: an incomplete
  // figure never passes as whole for want of a reason (G1d, PR-R).
  let incomplete = false;
  const measures = combined(bought.costMinor, bought.troyOz, sold.netMinor, holdings.costMinor, holdings.troyOz);
  if (measures.state !== 'complete' && measures.reasons.length === 0) incomplete = true;
  else lines.push(...reasonsText(measures.reasons, overview));
  if (!provenNoneHeld(overview) && holdings.gainMinor.state !== 'complete') {
    if (holdings.gainMinor.reasons.length === 0) incomplete = true;
    else lines.push(...reasonsText(holdings.gainMinor.reasons, overview));
  }
  if (purchases === null) {
    lines.push(purchasesError
      ? 'purchases couldn’t be read, so cancelled and returned ones can’t be checked'
      : 'purchases weren’t read, so cancelled and returned ones can’t be checked');
  } else {
    const unsettled = purchases.purchases.filter((lot) => lot.units.cancelled + lot.units.returned > 0).length;
    if (unsettled > 0) {
      lines.push(`${plural(unsettled, 'cancelled or returned purchase', 'cancelled or returned purchases')}: refunds aren’t reconciled here`);
    }
  }
  return { scope, reasons: [...new Set(lines)], incomplete };
}

const heldNotValued = (spot: ReturnType<typeof spotShown>, metal: Metal) => (spot === 'prices-off'
  ? TOTALS_HELD_OFF
  : `Holdings are not valued: no usable CNBC close for ${metalName(metal)} is stored yet; their gain or loss is not included.`);

/** Why holdings are left out: its reasons in one sentence; else, for a reasonless incomplete figure, Astra's general line. */
const heldWhy = (reasons: readonly string[], incomplete: boolean) => (reasons.length > 0
  ? `Holdings are not included in this result: ${reasons.join('; ')}.`
  : incomplete ? TOTALS_HELD_INCOMPLETE : 'Holdings are not included in this result.');

/** The third number for one metal, by the gates above. */
export function totalsResult(input: GoldTotalsInput, proof: GoldCoverageProof | null): GoldTotalsResult {
  const { overview } = input;
  const { activity: { sold, profit, from }, holdings, price, metal } = overview;
  if (from !== null) {
    return { kind: 'unavailable', title: TOTALS_UNAVAILABLE, lead: TOTALS_NEEDS_ALL_TIME, lines: [TOTALS_NEEDS_ALL_TIME], action: 'review' };
  }
  const spot = spotShown(price);
  const noSales = sold.lines === 0;
  const blocks = salesResultBlocks(overview, proof);
  const salesCoverage = blocks.notCovered || scopeLines(proof?.sales ?? null).length > 0;
  if (blocks.notCovered || blocks.lines.length > 0) {
    const action = salesCoverage ? 'coverage' : 'review';
    if (noSales) {
      return {
        kind: 'unavailable', title: TOTALS_NO_SALES, lead: blocks.lines[0] ?? null,
        lines: [...(spot === 'shown' ? [] : [heldNotValued(spot, metal)]), ...blocks.lines], action,
      };
    }
    return blocks.notCovered
      ? { kind: 'unavailable', title: TOTALS_NOT_COVERED, lead: null, lines: blocks.lines, action }
      : { kind: 'unavailable', title: TOTALS_UNAVAILABLE, lead: blocks.lines[0] ?? null, lines: blocks.lines, action };
  }
  const realized = noSales ? 0 : profit.valueMinor.value!;
  const method = fungibleFor(overview, metal) ? TOTALS_SALES_METHOD_FUNGIBLE : TOTALS_SALES_METHOD;
  const unpriced = spot !== 'shown' && estimateWithoutPrice(overview);
  if (spot !== 'shown' && !unpriced) {
    return noSales
      ? { kind: 'sales', valueMinor: 0, figure: null, lines: [spot === 'prices-off' ? TOTALS_NO_SALES_OFF : `${TOTALS_NO_SALES} ${heldNotValued(spot, metal)}`] }
      : { kind: 'sales', valueMinor: realized, figure: signedUsd(realized), lines: [TOTALS_SALES_BASIS, method, heldNotValued(spot, metal), TOTALS_BEFORE_REWARDS] };
  }
  const blocked = estimateBlocks(input, proof);
  if (blocked.scope.length > 0 || blocked.reasons.length > 0 || blocked.incomplete) {
    const why = [heldWhy(blocked.reasons, blocked.incomplete), ...blocked.scope];
    return noSales
      ? {
        kind: 'unavailable', title: TOTALS_NO_SALES, lead: blocked.scope[0] ?? why[0], lines: why,
        action: blocked.scope.length > 0 ? 'coverage' : 'review',
      }
      : { kind: 'sales', valueMinor: realized, figure: signedUsd(realized), lines: [TOTALS_SALES_BASIS, method, ...why, TOTALS_BEFORE_REWARDS] };
  }
  const gain = provenNoneHeld(overview) ? 0 : holdings.gainMinor.value!;
  const onTheWay = holdings.units.awaitingUnassigned;
  const onTheWayLine = `${plural(onTheWay, 'unit', 'units')} on the way ${onTheWay === 1 ? 'counts' : 'count'} at what you paid until delivered.`;
  if (unpriced) {
    // No price is used, so no value at spot and no quote or date is said: on-the-way units count at cost (Astra).
    return {
      kind: 'estimate',
      valueMinor: realized,
      figure: signedUsd(realized),
      unpriced: true,
      lines: [
        TOTALS_NO_PRICE_NEEDED,
        ...(onTheWay > 0 ? [TOTALS_BASIS_ON_THE_WAY_AT_COST, onTheWayLine] : [TOTALS_SALES_BASIS, method]),
        ...(noSales ? [TOTALS_NO_SALES] : []),
        TOTALS_BEFORE_REWARDS,
      ],
    };
  }
  return {
    kind: 'estimate',
    valueMinor: realized + gain,
    figure: signedUsd(realized + gain),
    lines: [
      TOTALS_ESTIMATE_QUALIFIER,
      onTheWay > 0 ? TOTALS_ESTIMATE_BASIS_CARRY : TOTALS_ESTIMATE_BASIS,
      ...(onTheWay > 0 ? [onTheWayLine] : []),
      ...(noSales ? [TOTALS_NO_SALES] : []),
      `Estimated using ${metalName(metal)} spot · CNBC close, ${dateText(price.closeDate!)}. Not a guaranteed sale price.`,
      TOTALS_BEFORE_REWARDS,
    ],
  };
}

/** One metal's totals: its three numbers over all recorded history, as of the read's date. */
export function goldTotals(input: GoldTotalsInput, proof: GoldCoverageProof | null): GoldTotals {
  const { overview } = input;
  const result = totalsResult(input, proof);
  const bought = boughtRow(overview, proof);
  const sold = soldRow(overview, proof);
  return {
    metal: overview.metal,
    heading: `Your ${metalName(overview.metal)} · all recorded history`,
    asOf: `As of ${dateText(overview.asOf)}`,
    bought,
    sold,
    resultLabel: resultLabelOf(result),
    result,
    why: totalsWhy(bought, sold, result),
  };
}

/** "Gold and silver combined", "Gold, silver and platinum combined". */
export function combinedTitle(metals: readonly Metal[]): string {
  const names = metals.map((metal, index) => (index === 0 ? metalTitle(metal) : metalName(metal)));
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} combined`;
}

function combinedMoney(parts: ReadonlyArray<{ metal: Metal; measure: MetalsMeasure<number>; count: number; row: GoldTotalsRow }>,
  none: string, unresolved: string | null, leftOut: string | null): Omit<GoldTotalsRow, 'sub'> {
  // The unresolved-metal exclusion is the same under every metal: said once, unprefixed, never as each metal's own.
  const limits = [
    ...parts.flatMap((part) => part.row.limits.filter((limit) => limit !== unresolved).map((limit) => `${metalTitle(part.metal)}: ${limit}`)),
    ...(unresolved ? [unresolved] : []),
  ];
  const unverified = parts.some((part) => part.row.unverified);
  const money = (): Pick<GoldTotalsRow, 'figure' | 'state'> => {
    if (parts.some((part) => part.measure.value === null)) return { figure: '—', state: 'unknown' };
    if (parts.every((part) => part.count === 0 && part.measure.state === 'complete')) return { figure: none, state: 'none' };
    const total = parts.reduce((sum, part) => sum + part.measure.value!, 0);
    return { figure: usd(total), state: parts.every((part) => part.measure.state === 'complete') ? 'complete' : 'partial' };
  };
  const { figure, state } = money();
  return { figure, state, short: shortLimit(state, leftOut, unverified), unverified, limits };
}

/** The metals together: the totals' rows and result, over every metal with records. */
export type GoldCombinedTotals = Omit<GoldTotals, 'metal' | 'asOf'> & { metals: Metal[] };

/**
 * The metals together, money only (ounces of different metals are never added): each number the sum of the metals'
 * complete figures, on one basis. The result is unavailable when any metal's is, when the metals' results stand on
 * different bases (one includes holdings, another doesn't), or while a purchase or sale has an unresolved metal.
 * Null with fewer than two metals.
 */
export function combinedTotals(parts: ReadonlyArray<{ input: GoldTotalsInput; totals: GoldTotals }>): GoldCombinedTotals | null {
  if (parts.length < 2) return null;
  const metals = parts.map((part) => part.totals.metal);
  const { metalUnknown } = parts[0].input.overview;
  const unknownMetal = metalUnknown.lots + metalUnknown.sales;
  const bought = combinedMoney(parts.map((part) => ({ metal: part.totals.metal, measure: part.input.overview.activity.bought.costMinor,
    count: part.input.overview.activity.bought.lots, row: part.totals.bought })), 'No recorded purchases',
  metalUnknown.lots > 0 ? unresolvedMetalLine('purchase', metalUnknown.lots) : null, leftOutShort('purchase', metalUnknown.lots));
  const sold = combinedMoney(parts.map((part) => ({ metal: part.totals.metal, measure: part.input.overview.activity.sold.netMinor,
    count: part.input.overview.activity.sold.lines, row: part.totals.sold })), 'No sales recorded',
  metalUnknown.sales > 0 ? unresolvedMetalLine('sale', metalUnknown.sales) : null, leftOutShort('sale', metalUnknown.sales));
  const results = parts.map((part) => part.totals.result);
  const why: string[] = [];
  if (unknownMetal > 0) why.push(sentence(metalUnknownText(unknownMetal)));
  parts.forEach((part) => {
    if (part.totals.result.kind === 'unavailable') why.push(`${metalTitle(part.totals.metal)}’s profit or loss is unavailable.`);
  });
  const kinds = new Set(results.map((result) => result.kind));
  if (why.length === 0 && kinds.size > 1) {
    why.push('One metal’s figure includes what you hold and another’s doesn’t, so they can’t be added.');
  }
  let result: GoldTotalsResult;
  if (why.length > 0) {
    const coverage = results.some((item) => item.kind === 'unavailable' && item.action === 'coverage');
    result = { kind: 'unavailable', title: TOTALS_COMBINED_UNAVAILABLE, lead: why[0], lines: why, action: coverage ? 'coverage' : 'review' };
  } else {
    const valueMinor = results.reduce((sum, item) => sum + (item.kind === 'unavailable' ? 0 : item.valueMinor), 0);
    const kind = results[0].kind as 'estimate' | 'sales';
    const noSales = results.every((item) => item.kind === 'sales' && item.figure === null);
    // No metal's figure used a price (each has no delivered holdings left): no holdings-valuation claim, and units on the
    // way said at cost (Astra).
    const unpriced = results.every((item) => item.kind === 'estimate' && item.unpriced === true);
    const carried = parts.some((part) => part.input.overview.holdings.units.awaitingUnassigned > 0);
    result = kind === 'estimate'
      ? {
        kind, valueMinor, figure: signedUsd(valueMinor),
        lines: unpriced
          ? [TOTALS_NO_PRICE_NEEDED, ...(carried ? [TOTALS_BASIS_ON_THE_WAY_AT_COST] : []), TOTALS_BEFORE_REWARDS]
          : [TOTALS_ESTIMATE_QUALIFIER, TOTALS_BEFORE_REWARDS],
        ...(unpriced ? { unpriced: true as const } : {}),
      }
      : noSales
        ? { kind, valueMinor: 0, figure: null, lines: [TOTALS_COMBINED_NO_SALES] }
        : { kind, valueMinor, figure: signedUsd(valueMinor), lines: [TOTALS_SALES_BASIS, TOTALS_HELD_EXCLUDED, TOTALS_BEFORE_REWARDS] };
  }
  const boughtTotal: GoldTotalsRow = { ...bought, sub: 'money only; ounces of different metals aren’t added' };
  const soldTotal: GoldTotalsRow = { ...sold, sub: 'proceeds after fees' };
  return {
    metals,
    heading: combinedTitle(metals),
    bought: boughtTotal,
    sold: soldTotal,
    resultLabel: resultLabelOf(result),
    result,
    why: totalsWhy(boughtTotal, soldTotal, result),
  };
}
