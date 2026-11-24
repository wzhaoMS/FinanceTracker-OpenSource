import type {
  Metal,
  MetalsAssignmentMethod,
  MetalsCardLinkState,
  MetalsClassForm,
  MetalsClassUnits,
  MetalsCompletenessCode,
  MetalsCompletenessReason,
  MetalsContent,
  MetalsContentHold,
  MetalsCoverageEntry,
  MetalsDeliveryState,
  MetalsDepositLinkState,
  MetalsForInformation,
  MetalsFundingPurchase,
  MetalsHoldingClass,
  MetalsHoldingSource,
  MetalsMeasure,
  MetalsNeedsYou,
  MetalsOverview,
  MetalsPriceUsed,
  MetalsProduct,
  MetalsProfitCoverage,
  MetalsProfitEstimate,
  MetalsPurchase,
  MetalsPurchaseCard,
  MetalsSale,
  MetalsSalePayout,
  MetalsSource,
  MetalsTimelineMonth,
  MetalsTroyOz,
  MetalsUnmatchedReason,
} from './goldApi';
import { formatMinor, longDate, monthLabel } from '../spending/spendingFormat';

/**
 * The Gold page's words (design v8 §11, as Astra reviewed them), kept here so every figure says what it is, what it is
 * as of or over, and why it is not complete. Unknown is never zero: a figure without a value is "—" with why, and a
 * partial one says what it leaves out. Pure: no clock, no network.
 */

export const METAL_NAMES: Record<Metal, string> = { XAU: 'gold', XAG: 'silver', XPT: 'platinum', XPD: 'palladium' };
/** The switch's metals: gold and silver always (the ledger holds both in v1); platinum and palladium once recorded. */
export const SWITCH_METALS: readonly Metal[] = ['XAU', 'XAG'];

export const metalName = (metal: Metal) => METAL_NAMES[metal];
export const metalTitle = (metal: Metal) => capitalize(METAL_NAMES[metal]);

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const usd = (amountMinor: number) => formatMinor(amountMinor, 'USD');

/** A gain or loss: "+$12.00", "−$3.50", "$0.00". */
export function signedUsd(amountMinor: number): string {
  if (amountMinor > 0) return `+${usd(amountMinor)}`;
  if (amountMinor < 0) return `−${usd(-amountMinor)}`;
  return usd(0);
}

export const troyOz = (oz: MetalsTroyOz) => `${oz.display} troy oz`;

export const dateText = (date: string) => longDate(date);

/** The metals the switch offers: gold and silver, and any other metal the ledger holds. */
export function switchMetals(overview: Pick<MetalsOverview, 'metals'> | null): Metal[] {
  const held = (overview?.metals ?? []).filter((entry) => entry.lots + entry.sales > 0).map((entry) => entry.metal);
  return [...SWITCH_METALS, ...(['XPT', 'XPD'] as const).filter((metal) => held.includes(metal))];
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/** Each reason in plain words, with how many records it concerns. */
export function reasonText(reason: MetalsCompletenessReason, metal: Metal): string {
  const n = reason.records;
  switch (reason.code) {
    case 'content-unknown':
      return `${plural(n, 'purchase or sale has', 'purchases or sales have')} unknown content`;
    case 'unmatched-sales':
      return `${plural(n, 'sale has', 'sales have')} units with no recorded purchase`;
    case 'cost-estimated':
      return `${plural(n, 'sale has', 'sales have')} units with no recorded purchase, at a cost estimated from your nearest purchase of the same kind`;
    case 'cost-unattributed':
      return n === 1
        ? '1 purchase has part of its order\'s cost not assigned to it'
        : `${n} purchases have part of their order's cost not assigned to them`;
    case 'conflict':
      return `${plural(n, 'order has', 'orders have')} records that disagree, waiting for review, not counted`;
    case 'date-unknown':
      return `${plural(n, 'record has', 'records have')} no known date`;
    case 'price-missing':
      return `no CNBC daily close for ${metalName(metal)} is recorded`;
    case 'price-stale':
      return `the latest ${metalName(metal)} close is more than 5 weekdays old`;
    case 'source-held':
      return `${plural(n, 'record is', 'records are')} held and not counted`;
    case 'not-covered':
      return 'not every day is covered by a source\'s capture';
  }
}

/** The state word a figure carries: "Partial", "Unknown", or nothing when complete. */
export function stateWord(measure: Pick<MetalsMeasure<unknown>, 'state'>): string | null {
  if (measure.state === 'partial') return 'Partial';
  if (measure.state === 'unknown') return 'Unknown';
  return null;
}

/**
 * A figure's warning line: "Partial: …" or "Unknown: …", each reason once. `owner` says what waits for the owner
 * instead of the bare code where the page knows it (products to confirm, units sold with no recorded purchase).
 */
export function measureWarning(
  measure: Pick<MetalsMeasure<unknown>, 'state' | 'reasons'>,
  metal: Metal,
  owner: Partial<Record<MetalsCompletenessCode, string>> = {},
): string | null {
  const word = stateWord(measure);
  if (!word) return null;
  const parts = measure.reasons.map((reason) => owner[reason.code] ?? reasonText(reason, metal));
  return parts.length > 0 ? `${word}: ${[...new Set(parts)].join(' · ')}` : word;
}

/** The value of a money figure, or "—" when unknown. */
export function moneyFigure(measure: MetalsMeasure<number>, signed = false): string {
  if (measure.value === null) return '—';
  return signed ? signedUsd(measure.value) : usd(measure.value);
}

export function ozFigure(measure: MetalsMeasure<MetalsTroyOz>): string {
  return measure.value === null ? '—' : troyOz(measure.value);
}

/** A figure in running text with its state said beside it: "$2,140.00 (partial)", "— (unknown)"; complete as it is. */
export function withState(text: string, measure: Pick<MetalsMeasure<unknown>, 'state'>): string {
  return measure.state === 'complete' ? text : `${text} (${measure.state})`;
}

/** Exact troy ounces as a number, for drawing only: "1/31103477" and the like, never its rounded display. */
export function troyOzNumber(oz: MetalsTroyOz): number {
  const [num, den = '1'] = oz.exact.split('/');
  return Number(num) / Number(den);
}

/** A round top for the ounces scale: 1, 2 or 5 times a power of ten, at least the tallest month (a 1 g bar tops out at 0.05). */
export function ouncesTop(max: number): number {
  if (!(max > 0)) return 0;
  const power = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].map((step) => step * power).find((top) => top >= max - 1e-12)) ?? 10 * power;
}

/** A chart tick's ounces with the decimals it needs, never rounded onto another gridline: 0.25, not 0.3; 0.05, not 0.1. */
export function ouncesTick(tick: number): string {
  for (let decimals = 0; decimals <= 6; decimals += 1) {
    const text = tick.toFixed(decimals);
    if (Math.abs(Number(text) - tick) < 1e-9) return `${text} oz`;
  }
  return `${tick.toFixed(6)} oz`;
}

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

export const HOLDINGS_LABEL = 'Recorded holdings';
export const HOLDINGS_SUBTITLE = 'Delivered purchases not assigned to a sale';

export function asOfText(asOf: string): string {
  return `as of ${dateText(asOf)}`;
}

/** What the owner can act on, said instead of the bare codes, for the headline's warning. */
export function ownerReasons(overview: MetalsOverview): Partial<Record<MetalsCompletenessCode, string>> {
  const owner: Partial<Record<MetalsCompletenessCode, string>> = {};
  const products = productsToConfirm(overview.toCheck.needsYou);
  if (products > 0) owner['content-unknown'] = confirmProductsSentence(products);
  const unmatched = overview.holdings.units.unmatched;
  if (unmatched > 0) owner['unmatched-sales'] = unmatchedSentence(unmatched);
  return owner;
}

export function productsToConfirm(needsYou: readonly MetalsNeedsYou[]): number {
  return needsYou.reduce((total, item) => total + (item.code === 'confirm-content' || item.code === 'confirmation-drift' ? item.products : 0), 0);
}

/** What waits for the owner's answer on this page: the products whose content they confirm here. */
export function confirmProductsSentence(products: number): string {
  return products === 1 ? '1 product needs your answer: what it contains' : `${products} products need your answer: what each contains`;
}

export function unmatchedSentence(units: number): string {
  return units === 1 ? '1 unit sold has no recorded purchase' : `${units} units sold have no recorded purchase`;
}

/** The worse of several measures' states, with every reason once (the most records a code concerns). */
export function combined(...measures: Array<Pick<MetalsMeasure<unknown>, 'state' | 'reasons'>>): Pick<MetalsMeasure<unknown>, 'state' | 'reasons'> {
  const rank = { complete: 0, partial: 1, unknown: 2 } as const;
  const state = measures.reduce<'complete' | 'partial' | 'unknown'>((worst, item) => (rank[item.state] > rank[worst] ? item.state : worst), 'complete');
  const reasons = new Map<string, MetalsCompletenessReason>();
  for (const item of measures) {
    for (const reason of item.reasons) {
      const seen = reasons.get(reason.code);
      if (!seen || seen.records < reason.records) reasons.set(reason.code, reason);
    }
  }
  return { state: state === 'complete' && reasons.size > 0 ? 'partial' : state, reasons: [...reasons.values()] };
}

/** The headline's warning: its ounces and cost together, what waits for the owner said instead of the bare codes. */
export function headlineWarning(overview: MetalsOverview): string | null {
  return measureWarning(combined(overview.holdings.troyOz, overview.holdings.costMinor), overview.metal, ownerReasons(overview));
}

/** The activity rows' warnings: bought (ounces and cost), sold (ounces and net), and profit once it has a value. */
export function activityWarnings(overview: MetalsOverview): { bought: string | null; sold: string | null; profit: string | null } {
  const { activity: { bought, sold, profit }, metal } = overview;
  return {
    bought: measureWarning(combined(bought.troyOz, bought.costMinor), metal),
    sold: measureWarning(combined(sold.troyOz, sold.netMinor), metal),
    // With no value, the row says why instead (profitUnknownText).
    profit: profit.valueMinor.value === null ? null : measureWarning(profit.valueMinor, metal),
  };
}

/**
 * Why sold units have no recorded purchase today (§4.3), beside "sold with no recorded purchase": one reason said whole,
 * several each with its count ("1 likely bought …; 1 whose purchase was cancelled or returned after the sale"). Null
 * when no reason is given.
 */
export function unmatchedReasonsText(reasons: ReadonlyArray<{ reason: MetalsUnmatchedReason; units: number }>): string | null {
  const before = 'likely bought before a source\'s records begin, or from a source not captured';
  if (reasons.length === 0) return null;
  if (reasons.length === 1) {
    const [{ reason, units }] = reasons;
    if (reason === 'no-recorded-purchase') return before;
    return units === 1 ? 'its purchase was cancelled or returned after the sale' : 'their purchases were cancelled or returned after the sale';
  }
  return reasons.map(({ reason, units }) => (reason === 'no-recorded-purchase'
    ? `${units} ${before}`
    : `${units} whose ${units === 1 ? 'purchase was' : 'purchases were'} cancelled or returned after the sale`)).join('; ');
}

/** The period's sales with no recorded purchase today, and why: "Sold with no recorded purchase: 1 unit, $… net (…)". */
export function soldUnmatchedText(unmatched: MetalsOverview['activity']['sold']['unmatched']): string | null {
  if (unmatched.units === 0) return null;
  const why = unmatchedReasonsText(unmatched.reasons);
  return `Sold with no recorded purchase: ${plural(unmatched.units, 'unit', 'units')}, ${usd(unmatched.netMinor)} net${why ? ` (${why})` : ''}`;
}

/** The reasons To check gives for today's units sold with no recorded purchase, for the headline (holdings as of today). */
export function unmatchedReasonsOf(overview: Pick<MetalsOverview, 'toCheck'>): Array<{ reason: MetalsUnmatchedReason; units: number }> {
  const item = overview.toCheck.forInformation.find((entry) => entry.code === 'unmatched-sales');
  return item && item.code === 'unmatched-sales' ? item.reasons : [];
}

/**
 * The recorded holdings figure. With nothing held and units sold that no recorded purchase covers, the deliveries are
 * said to be short instead of a bare zero (`figure` null).
 */
export function holdingsFigure(overview: MetalsOverview): { figure: string | null; short: string | null } {
  const { troyOz: oz, units } = overview.holdings;
  if (units.held === 0 && units.unmatched > 0) {
    return { figure: null, short: `Recorded deliveries are short by ${plural(units.unmatched, 'unit', 'units')}` };
  }
  return { figure: ozFigure(oz), short: null };
}

/**
 * The ounces' reasons under which "all your recorded purchases kept or on the way are sold" stays true: sales with no
 * recorded purchase, and coverage gaps (records never captured, not a recorded purchase kept out). Any other reason
 * (unknown content, a record held for review, an order in conflict, an uncertain date) can keep a recorded purchase out
 * of the units.
 */
const HELD_UNKNOWN_REASONS: ReadonlySet<MetalsCompletenessCode> = new Set<MetalsCompletenessCode>(['unmatched-sales', 'not-covered']);

/**
 * Why recorded holdings are unknown when every recorded purchase kept or on the way is sold (never "every purchase":
 * one cancelled or returned was not) and units sold have no purchase recorded at all (ROOT, from the owner's page): in
 * plain words, never as a zero. The count is the read's own (`holdings.units.unmatched`), and To check must account for
 * each of those units as never having had a recorded purchase (none cancelled or returned since its sale). Only when
 * those sales are all that keeps the ounces unknown is it said as the cause, with what finding those purchases would
 * settle: whether you hold 0, never that you do (a purchase found may hold more units than were sold). With coverage
 * gaps too, the facts alone show. An estimated cost is never a holding: the words are the same whatever the owner's
 * estimate switch says. Null in every other state: anything held, or on the way and not sold; any purchase of unknown
 * content or metal recorded, kept or not (the `lots` count, stricter than the kept `units`: one cancelled or returned
 * hides the line too); or any other reason.
 */
export function heldUnknownText(overview: Pick<MetalsOverview, 'holdings' | 'metalUnknown' | 'toCheck'>): string | null {
  const { troyOz: oz, units, contentUnknown } = overview.holdings;
  if (oz.value !== null || units.unmatched === 0 || units.held > 0 || units.awaitingUnassigned > 0) return null;
  if (contentUnknown.lots > 0 || overview.metalUnknown.lots > 0) return null;
  if (!oz.reasons.some(({ code }) => code === 'unmatched-sales') || oz.reasons.some(({ code }) => !HELD_UNKNOWN_REASONS.has(code))) return null;
  const parts = unmatchedReasonsOf(overview);
  const accounted = parts.reduce((total, part) => total + part.units, 0);
  if (accounted !== units.unmatched || parts.some(({ reason }) => reason !== 'no-recorded-purchase')) return null;
  const sold = units.unmatched === 1 ? '1 unit you sold has' : `${units.unmatched} units you sold have`;
  const facts = `all your recorded purchases kept or on the way are sold, but ${sold} no recorded purchase yet.`;
  if (oz.reasons.some(({ code }) => code !== 'unmatched-sales')) return `Unknown: ${facts}`;
  return `Unknown because ${facts} Finding ${units.unmatched === 1 ? 'that purchase' : 'those purchases'} would confirm whether you `
    + 'hold 0 troy oz.';
}

/**
 * Whether values at spot show (v0, fail-closed): a Holdr that doesn't fetch closes shows none, whatever closes it has
 * stored ("Prices off"); one that fetches but has no usable close yet says so ("No price yet"). Only then do values
 * show, a stale close with its partial and stale words. Ounces and costs never depend on it.
 */
export type GoldSpot = 'shown' | 'prices-off' | 'no-price-yet';

export function spotShown(price: Pick<MetalsPriceUsed, 'fetching' | 'closeDate'>): GoldSpot {
  if (!price.fetching) return 'prices-off';
  return price.closeDate === null ? 'no-price-yet' : 'shown';
}

export const SPOT_OFF_WORDS: Record<Exclude<GoldSpot, 'shown'>, string> = { 'prices-off': 'Prices off', 'no-price-yet': 'No price yet' };

/** A value or gain at spot as the page writes it: its figure while values show, else why none does, never a number. */
export function spotFigure(measure: MetalsMeasure<number>, spot: GoldSpot, signed = false): string {
  return spot === 'shown' ? moneyFigure(measure, signed) : SPOT_OFF_WORDS[spot];
}

/** "Estimated value at spot · gold, CNBC daily close of Nov 6, 2026 · not a price you could sell at today". */
export function priceNote(price: MetalsPriceUsed, metal: Metal): string {
  const spot = spotShown(price);
  if (spot === 'prices-off') {
    return 'Prices off: this Holdr doesn\'t fetch CNBC daily closes, so no value or gain at spot shows. Ounces and costs still show.';
  }
  if (spot === 'no-price-yet' || price.closeDate === null) {
    return `No price yet: no usable CNBC daily close for ${metalName(metal)} is stored yet, so no value or gain at spot shows. `
      + 'Ounces and costs still show.';
  }
  const base = `Estimated value at spot · ${metalName(metal)}, CNBC daily close of ${dateText(price.closeDate)} · not a price you could sell at today`;
  return price.stale ? `${base} · that close is more than 5 weekdays old` : base;
}

/**
 * The price guard's level-shift note (D-G3-1), beside the price line: a move of more than 20% the guard refused until
 * the new level held ("admitted after N days"), or is still refusing (then the close used is the last one before it).
 */
export function levelShiftText(shift: MetalsPriceUsed['levelShift']): string | null {
  if (!shift) return null;
  const moved = `Price moved more than 20% on ${dateText(shift.movedOn)}`;
  return shift.admittedOn === null
    ? `${moved}; not admitted yet, ${plural(shift.days, 'day', 'days')} on: values use the last close before the move.`
    : `${moved}; admitted after ${plural(shift.days, 'day', 'days')}, on ${dateText(shift.admittedOn)}.`;
}

/**
 * Purchases and sales whose metal is unresolved (a title naming several metals, or bullion whose metal isn't confirmed):
 * beside every metal's figures, never inside them. The served counts don't say which reason each has, so the line says
 * only that the metal is unresolved (Astra).
 */
export function metalUnknownLine(unknown: MetalsOverview['metalUnknown']): string | null {
  if (unknown.lots === 0 && unknown.sales === 0) return null;
  const parts = [
    unknown.sales > 0 ? `Sales with unknown metal: ${unknown.sales} (net ${usd(unknown.saleNetMinor)})` : null,
    unknown.lots > 0
      ? `Purchases with unknown metal: ${unknown.lots} (${plural(unknown.units, 'unit', 'units')} kept or on the way, cost `
        + `${usd(unknown.costMinor)})` : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join(' · ')}. Their metal is unresolved, so they are not included in any metal's figures.`;
}

/**
 * Beside a metal's holdings (its ounces, value and gain), while any unit bought and kept or on the way has an unresolved
 * metal: those units are in no metal's figures, so a holding of none, or its value, is never proof (G1d). Counted in
 * units, the kept units the overview serves; a purchase cancelled or returned since says nothing here. Under the chart of
 * what was held, scoped to it (`inChart`), never implying they were held in every month shown. Null otherwise.
 */
export function unresolvedMetalHeldLine(unknown: MetalsOverview['metalUnknown'], inChart = false): string | null {
  if (unknown.units <= 0) return null;
  return `Not counted${inChart ? ' in this chart' : ''}: ${plural(unknown.units, 'unit', 'units')} bought whose metal is unresolved.`;
}

/**
 * What awaits delivery, each figure with its state: "Awaiting delivery: 1.000 troy oz (partial), of which 0.500 (partial)
 * not assigned to a sale". Unknown is said, never a number: "2 units (ounces unknown)", "of which — (unknown) not
 * assigned to a sale" (G3 sends a zero with reasons as unknown).
 */
export function awaitingLine(overview: MetalsOverview): string | null {
  const { units, awaitingTroyOz, awaitingUnassignedTroyOz } = overview.holdings;
  if (units.awaiting === 0) return null;
  const all = awaitingTroyOz.value === null
    ? `${plural(units.awaiting, 'unit', 'units')} (ounces unknown)`
    : withState(troyOz(awaitingTroyOz.value), awaitingTroyOz);
  const free = withState(awaitingUnassignedTroyOz.value === null ? '—' : awaitingUnassignedTroyOz.value.display, awaitingUnassignedTroyOz);
  return `Awaiting delivery: ${all}, of which ${free} not assigned to a sale`;
}

/** Purchases whose content is unknown, outside every ounce figure: said beside the headline, never folded in. */
export function contentUnknownLine(overview: MetalsOverview): string | null {
  const unknown = overview.holdings.contentUnknown;
  if (unknown.lots === 0 && unknown.sales === 0) return null;
  const parts: string[] = [];
  if (unknown.lots > 0) {
    parts.push(`${plural(unknown.lots, 'purchase', 'purchases')} (${plural(unknown.units, 'unit', 'units')} kept or on the way, cost `
      + `${usd(unknown.costMinor)}) with unknown content`);
  }
  if (unknown.sales > 0) parts.push(`${plural(unknown.sales, 'sale', 'sales')} (net ${usd(unknown.saleNetMinor)}) with unknown content`);
  return `Not in the ounces above: ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Reconciliation (per class and overall)
// ---------------------------------------------------------------------------

/** "Delivered 4 · Sold 3 · Recorded holdings 2", then why D − S ≠ H, each part named. */
/**
 * How recorded holdings add up, in units. Units sold with no recorded purchase carry their reasons when the reasons
 * given add up to them (the page reads holdings as of today, as To check's reasons are). `deliveryInferred` is the
 * class's `reconciliation.deliveryInferred`: units its Delivered counts only because a sale took them (the owner's
 * fungible policy); none, the lines are as before.
 */
export function reconciliationLines(units: MetalsClassUnits, reasons: ReadonlyArray<{ reason: MetalsUnmatchedReason; units: number }> = [],
  deliveryInferred = 0): string[] {
  const lines = [`Delivered ${units.delivered} · Sold ${units.sold} · Recorded holdings ${units.held}`];
  if (deliveryInferred > 0) lines.push(deliveryInferredText(deliveryInferred));
  if (units.delivered - units.sold === units.held) return lines;
  if (units.soldFromAwaiting > 0) {
    lines.push(`${plural(units.soldFromAwaiting, 'unit was', 'units were')} sold while awaiting delivery: assigned to a purchase not delivered yet`);
  }
  if (units.unmatched > 0) {
    const why = reasons.reduce((total, part) => total + part.units, 0) === units.unmatched ? unmatchedReasonsText(reasons) : null;
    lines.push(`${plural(units.unmatched, 'unit was', 'units were')} sold with no recorded purchase${why ? `: ${why}` : ''}`);
  }
  return lines;
}

const FORM_WORDS: Record<MetalsClassForm, { one: string; many: string }> = {
  bar: { one: 'bar', many: 'bars' },
  coin: { one: 'coin', many: 'coins' },
  round: { one: 'round', many: 'rounds' },
  unstated: { one: 'piece, form not stated', many: 'pieces, form not stated' },
  // The owner's fungible policy (HOLDR_METALS_FUNGIBLE): one class across forms, assigned oldest first.
  any: { one: 'piece of any form', many: 'pieces of any form' },
};

/** "1 troy oz gold bars": the class, by its fine content per unit and its form. */
export function classTitle(item: Pick<MetalsHoldingClass, 'form' | 'fineTroyOzPerUnit'>, metal: Metal): string {
  return `${item.fineTroyOzPerUnit.display} troy oz ${metalName(metal)} ${FORM_WORDS[item.form].many}`;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type GoldPeriodChoice = '1m' | '3m' | '6m' | 'ytd' | 'all';
export const PERIOD_CHOICES: readonly GoldPeriodChoice[] = ['1m', '3m', '6m', 'ytd', 'all'];
export const PERIOD_LABELS: Record<GoldPeriodChoice, string> = { '1m': '1M', '3m': '3M', '6m': '6M', ytd: 'YTD', all: 'All' };
export const PERIOD_NAMES: Record<GoldPeriodChoice, string> = {
  '1m': 'Last month', '3m': 'Last 3 months', '6m': 'Last 6 months', ytd: 'This year so far', all: 'All time',
};

/**
 * The period's dates for `today` (a New York date), rolling back from today (ROOT's default): the day after the same
 * day 1, 3 or 6 months before (a shorter month's last day standing in for a missing one), this calendar year so far, or
 * all history.
 */
export function periodDates(choice: GoldPeriodChoice, today: string): { from: string | null; to: string } {
  if (choice === 'all') return { from: null, to: today };
  if (choice === 'ytd') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  const months = choice === '1m' ? 1 : choice === '3m' ? 3 : 6;
  const first = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - months, 1));
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const from = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(Number(today.slice(8, 10)), days) + 1));
  return { from: from.toISOString().slice(0, 10), to: today };
}

/** What the period applies to, said on the period's figures and the lists. */
export function periodScope(choice: GoldPeriodChoice, period: { from: string | null; to: string }): string {
  if (choice === 'all') return 'all recorded history';
  return `${PERIOD_NAMES[choice].toLowerCase()} (${period.from ? `${dateText(period.from)} – ` : ''}${dateText(period.to)})`;
}

/**
 * What the period's profit or loss sums, on its coverage's basis. While the owner's estimate switch gives units sold with
 * no recorded purchase an estimated cost (`estimate`), the figure sums those too, so the basis counts them apart from what
 * is known; with none estimated in the period it reads exactly as without the switch.
 */
export function profitCoverageText(coverage: MetalsProfitCoverage, estimate?: MetalsProfitEstimate): string {
  const estimated = estimate !== undefined && estimate.estimated.units > 0 ? estimate.estimated : null;
  if (coverage.basis === 'troy-oz') {
    return estimated
      ? `known for ${coverage.known.display} and estimated for ${estimated.troyOz.display} of ${coverage.total.display} troy oz sold`
      : `known for ${coverage.known.display} of ${coverage.total.display} troy oz sold`;
  }
  const base = estimated
    ? `known for ${coverage.known} and estimated for ${estimated.lines} of ${plural(coverage.total, 'sale line', 'sale lines')}`
    : `known for ${coverage.known} of ${plural(coverage.total, 'sale line', 'sale lines')}`;
  return coverage.unknownContentLines > 0
    ? `${base} · ${coverage.unknownContentLines} ${coverage.unknownContentLines === 1 ? 'has' : 'have'} unknown content`
    : base;
}

/** Every sale line's profit or loss is known: nothing sold is left out of the figure. */
export function profitFullyKnown(coverage: MetalsProfitCoverage): boolean {
  return coverage.basis === 'troy-oz'
    ? coverage.known.exact === coverage.total.exact
    : coverage.known === coverage.total && coverage.unknownContentLines === 0;
}

/**
 * The period's profit or loss: on all its sales only when each is known, else on the covered ones (Astra's headline
 * ruling). Each label says it is before rewards (ROOT, from the owner's reaction): a realized result never reads as a final
 * loss.
 */
export const PROFIT_SALES_LABEL = 'Profit or loss on these sales, before rewards';
export const PROFIT_COVERED_LABEL = 'Profit or loss on covered sales, before rewards';
export const PROFIT_METHOD = 'What the sales brought in minus what those units cost, earliest units first';
/** The period's method where the owner's fungible policy names the metal (`MetalsAssignmentMethod`). */
export const PROFIT_METHOD_FUNGIBLE = 'What the sales brought in minus what those units cost, earliest units first across all forms '
  + '(your rule)';
export const profitMethod = (fungible: boolean) => (fungible ? PROFIT_METHOD_FUNGIBLE : PROFIT_METHOD);

/** A period whose sales are known to be none (Astra's R5): said in words, never "$0.00" or a coverage of none. */
export const PERIOD_NO_SALES = 'No sales recorded in this period';

/**
 * The period's sales are known to be none: no sale line, the sales measure complete, and no sale of unresolved metal
 * recorded. Those are in no metal's sales, and `metalUnknown.sales` isn't by period: it counts each one not cancelled
 * and agreed on or before the overview's as-of date (today on this page), so one agreed on any date keeps the figures
 * in every period (conservative: one agreed outside the period can't be a sale in it). Sales that may be missing or
 * unread (a measure partial or unknown) keep their figure and its reasons; a zero result over recorded sales stays a
 * figure.
 */
export function periodSalesNone(overview: Pick<MetalsOverview, 'activity' | 'metalUnknown'>): boolean {
  const { sold } = overview.activity;
  return sold.lines === 0 && sold.netMinor.state === 'complete' && overview.metalUnknown.sales === 0;
}

/** Profit or loss with no known sale line: "—" with why, never $0. */
export function profitUnknownText(coverage: MetalsProfitCoverage, lines: number): string {
  if (lines === 0) return 'No sales in this period.';
  return `Not known for any sale line in this period: ${profitCoverageText(coverage)}.`;
}

export function soldDetail(sold: MetalsOverview['activity']['sold']): string {
  return `${withState(moneyFigure(sold.netMinor), sold.netMinor)} net · by day agreed, after `
    + `${withState(moneyFigure(sold.feesMinor), sold.feesMinor)} fees`;
}

/**
 * The period's payouts, by payout date: those of sales of this metal alone, then, apart and in no metal's totals,
 * those of sales of more than one metal or with a line of unknown metal (the same on each of their metals).
 */
export function payoutLines(payouts: MetalsOverview['activity']['payouts']): string[] {
  const lines: string[] = [];
  if (payouts.count > 0) {
    lines.push(`Paid out over the period: ${withState(moneyFigure(payouts.amountMinor), payouts.amountMinor)} in `
      + `${plural(payouts.count, 'payout', 'payouts')}, by payout date.`);
  }
  if (payouts.mixedMetal.count > 0) {
    lines.push(`Payouts of sales of more than one metal, or with a line of unknown metal: `
      + `${withState(moneyFigure(payouts.mixedMetal.amountMinor), payouts.mixedMetal.amountMinor)} in `
      + `${plural(payouts.mixedMetal.count, 'payout', 'payouts')}, counted in no one metal's totals.`);
  }
  return lines;
}

/** A sale whose assigned purchases a cancellation or return of unknown date could change (its result is partial). */
export const SALE_DATE_UNKNOWN_TEXT = 'A cancellation or return of unknown date among purchases of this kind could change which purchases this '
  + 'sale is assigned, so its result is partial.';
/** A sale whose assigned purchases a quarantined purchase of its kind could change (its result is partial). */
export const SALE_PURCHASE_CONFLICT_TEXT = 'A purchase of this kind has records that disagree, so which purchases this sale is assigned could '
  + 'change until they are reviewed; its result is partial.';

export interface GoldSaleNote { key: 'date-unknown' | 'purchase-conflict' | 'quarantined'; text: string; warning: boolean }

/** What a sale's details say under its lines, in order: a date-uncertain purchase, a purchase conflict, its own quarantine. */
export function saleNotes(sale: Pick<MetalsSale, 'dateUnknown' | 'purchaseConflict' | 'quarantined'>): GoldSaleNote[] {
  const notes: Array<GoldSaleNote | null> = [
    sale.dateUnknown ? { key: 'date-unknown', text: SALE_DATE_UNKNOWN_TEXT, warning: false } : null,
    sale.purchaseConflict ? { key: 'purchase-conflict', text: SALE_PURCHASE_CONFLICT_TEXT, warning: false } : null,
    sale.quarantined ? { key: 'quarantined', text: QUARANTINE_TEXT, warning: true } : null,
  ];
  return notes.filter((note): note is GoldSaleNote => note !== null);
}
/** A cycle whose purchase's order a later capture contradicts: its cost is contested. */
export const CYCLE_QUARANTINED_TEXT = 'This purchase\'s order has records that disagree, so its cost here is contested until they are reviewed.';

// ---------------------------------------------------------------------------
// To check
// ---------------------------------------------------------------------------

export function needsYouText(item: MetalsNeedsYou): string {
  switch (item.code) {
    case 'confirm-content':
      return confirmProductsSentence(item.products);
    case 'confirmation-drift':
      return item.products === 1 ? '1 purchase differs from what you confirmed' : `${item.products} purchases differ from what you confirmed`;
    case 'bullion-answer':
      return item.orders === 1 ? '1 order needs your answer: is this bullion?' : `${item.orders} orders need your answer: is this bullion?`;
    case 'exclusion-rule':
      return 'Review exclusion rule';
  }
}

export const CARD_LINK_WHY: Record<Exclude<MetalsCardLinkState, 'linked'>, string> = {
  ineligible: 'the order\'s records changed, so a match proves nothing',
  ambiguous: 'more than one card charge matches',
  'no-candidate': 'no card charge of that amount and date found',
  'competitor-unknown': 'another order could be that charge',
  'competitor-held': 'a held record could be that charge',
  'binding-missing': 'card not approved yet',
  'binding-drift': 'the card\'s details changed since it was approved',
};

export function depositWhy(state: Exclude<MetalsDepositLinkState, 'linked'>, coveredThrough: string | null | undefined): string {
  switch (state) {
    case 'not-covered':
      return coveredThrough ? `checking not imported after ${dateText(coveredThrough)}` : 'checking not imported for those dates';
    case 'possible':
      return 'a deposit of that amount and date, not confirmed as the payout';
    case 'ineligible':
      return 'the sale\'s records changed, so a match proves nothing';
    case 'ambiguous':
      return 'more than one deposit matches';
    case 'no-candidate':
      return 'no deposit of that amount and date found';
    case 'not-complete':
      return 'the payout isn\'t complete yet';
    case 'date-unknown':
      return 'the payout\'s date is unknown';
    case 'binding-missing':
      return 'checking account not approved yet';
    case 'binding-drift':
      return 'the checking account\'s details changed since it was approved';
  }
}

const HOLD_REASON_WORDS: Record<string, string> = {
  'return-unlinked': 'a return not tied to a purchase',
  'quantity-unknown': 'a quantity that doesn\'t read',
  'status-ambiguous': 'a status that doesn\'t add up',
  'inspection-failed': 'a failed inspection',
  'buy-side-unsupported': 'a dealer purchase',
  'vault-unsupported': 'vault storage',
};

export function forInformationText(item: MetalsForInformation): string {
  switch (item.code) {
    case 'unmatched-sales': {
      const why = unmatchedReasonsText(item.reasons);
      return `${unmatchedSentence(item.units)}${why ? `: ${why}` : ''}`;
    }
    case 'card-not-linked': {
      const whys = item.states.map((entry) => CARD_LINK_WHY[entry.state]);
      return `${plural(item.charges, 'card charge', 'card charges')} not linked (${[...new Set(whys)].join('; ')})`;
    }
    case 'deposit-not-linked': {
      const whys = item.states.map((entry) => depositWhy(entry.state, entry.coveredThrough));
      const own = item.deposits > 0 ? `${plural(item.deposits, 'deposit', 'deposits')} not linked (${[...new Set(whys)].join('; ')})` : null;
      const mixed = item.mixedMetal > 0
        ? `${plural(item.mixedMetal, 'deposit', 'deposits')} of sales of more than one metal, or with a line of unknown metal, not linked, `
          + 'counted in no one metal' : null;
      return [own, mixed].filter((part): part is string => part !== null).join('; ');
    }
    case 'source-held': {
      const named = item.reasons.map((entry) => HOLD_REASON_WORDS[entry.reason]).filter((text): text is string => Boolean(text));
      return `${plural(item.records, 'record', 'records')} a source couldn't read ${item.records === 1 ? 'is' : 'are'} held and not counted`
        + (named.length > 0 ? ` (${[...new Set(named)].join('; ')})` : '');
    }
    case 'conflict':
      return `${plural(item.orders, 'order has', 'orders have')} records that disagree, waiting for review, not counted`;
    case 'date-unknown':
      return `${plural(item.records, 'record has', 'records have')} no known date`;
    case 'cost-unattributed':
      return `${plural(item.orders, 'order has', 'orders have')} tax, shipping or discounts not assigned to its lines`;
    case 'metal-unknown':
      // Every line whose metal is null (a title naming several metals, or bullion whose metal isn't confirmed): Astra.
      return `${plural(item.records, 'record has', 'records have')} an unresolved metal, so ${item.records === 1 ? 'it is' : 'they are'} `
        + 'not included in any metal\'s figures';
    case 'premium-disagreement':
      return `${plural(item.records, 'sale states a premium', 'sales state premiums')} that can't be read or `
        + `${item.records === 1 ? 'doesn\'t' : 'don\'t'} match the price, so the agreed day's close stands in for `
        + `${item.records === 1 ? 'its' : 'their'} spot, a proxy`;
  }
}

/** Beside a sale's stated premium when it can't be read or doesn't reconcile with the price and content (G3). */
export const PREMIUM_DISAGREEMENT_TEXT = 'This premium can\'t be read or doesn\'t match the price, so the sale\'s spot is the agreed day\'s '
  + 'close, a proxy.';

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const CONTENT_BASIS_WORDS = {
  'owner-confirmed': 'you confirmed',
  'coin-specification': 'by coin specification',
  'stated-mass-basis': 'by the weight the title states',
} as const;

export const CONTENT_HOLD_WORDS: Record<MetalsContentHold, string> = {
  'metal-unknown': 'the title names more than one metal',
  'pack-count': 'a pack: how many pieces one unit holds needs you',
  'pack-unproven': 'the title doesn\'t show whether one unit is one piece',
  'weight-unstated': 'the title states no weight',
  'unit-unconfirmed': 'the title says oz, not troy oz',
  'mass-basis-unknown': 'the title doesn\'t say whether its weight is fine or gross',
  'fine-content-unknown': 'no specification says how much fine metal it holds',
  'confirmation-drift': 'details differ from what you confirmed',
  'bullion-unconfirmed': 'needs your answer: is this bullion?',
};

/** "1.000 troy oz (by coin specification)" or "Content unknown: the title states no weight". */
export function contentText(content: MetalsContent): string {
  if (content.known) return `${troyOz(content.troyOz)} (${CONTENT_BASIS_WORDS[content.basis]})`;
  return `Content unknown: ${CONTENT_HOLD_WORDS[content.hold]}`;
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

const SOURCE_NAMES: Record<MetalsSource, string> = { costco: 'Costco', walmart: 'Walmart', collectpure: 'CollectPure' };
export const sourceName = (source: MetalsSource) => SOURCE_NAMES[source];

export const DELIVERY_WORDS: Record<MetalsDeliveryState, string> = {
  delivered: 'Delivered',
  'in-store': 'Bought in store',
  shipped: 'Shipped, awaiting delivery',
  awaiting: 'Awaiting delivery',
  'partly-delivered': 'Partly delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
};

/** A row's name: its title as stored, or what it is when the title isn't shown. */
export function itemTitle(item: Pick<MetalsPurchase, 'title' | 'form'>, metal: Metal): string {
  return item.title?.trim() || `${capitalize(metalName(metal))} ${item.form ?? 'item'} (title not shown)`;
}

export function purchaseSummary(purchase: MetalsPurchase): string {
  const cost = purchase.costMinor.value === null ? 'Cost unknown' : withState(usd(purchase.costMinor.value), purchase.costMinor);
  return `${cost} · ${DELIVERY_WORDS[purchase.delivery.state]}`;
}

/** "1" or "3 ordered: 2 delivered, 1 awaiting delivery". */
export function unitsText(units: MetalsPurchase['units']): string {
  const parts = [
    units.delivered > 0 ? `${units.delivered} delivered` : null,
    units.awaiting > 0 ? `${units.awaiting} awaiting delivery` : null,
    units.cancelled > 0 ? `${units.cancelled} cancelled` : null,
    units.returned > 0 ? `${units.returned} returned` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 1 ? `${units.ordered} ordered: ${parts.join(', ')}` : String(units.ordered);
}

/** Wholly cancelled or returned: listed apart, never among the purchases that count. */
export const setAside = (purchase: Pick<MetalsPurchase, 'units'>) =>
  purchase.units.delivered === 0 && purchase.units.awaiting === 0;

/** A set-aside purchase's line in the cancelled list: "Cancelled · 1 · cost $1,990.00 (partial)", its cost with its state. */
export function setAsideMeta(purchase: Pick<MetalsPurchase, 'delivery' | 'units' | 'costMinor'>): string {
  return `${DELIVERY_WORDS[purchase.delivery.state]} · ${unitsText(purchase.units)} · cost ${withState(moneyFigure(purchase.costMinor), purchase.costMinor)}`;
}

/** A row's line in parts: words as they are, and figures that carry their state (the page shows it as a badge beside them). */
export type GoldLinePart = string | { figure: string; state: MetalsMeasure<unknown>['state'] };

/** The line as running text, each figure with its state said: "2 held · 2.000 troy oz (partial)". */
export function lineText(parts: readonly GoldLinePart[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : withState(part.figure, part))).join('');
}

/** A holding class's line under its name: "2 held · 2.000 troy oz (partial) · 1 awaiting delivery", its ounces with their state. */
export function classMetaParts(item: Pick<MetalsHoldingClass, 'units' | 'troyOz'>): GoldLinePart[] {
  return [
    `${item.units.held} held · `,
    { figure: ozFigure(item.troyOz), state: item.troyOz.state },
    item.units.awaiting > 0 ? ` · ${item.units.awaiting} awaiting delivery` : '',
  ];
}

/**
 * A source row's line: "Costco · 2 units · 2.000 troy oz · cost $4,000.00 · value at spot — (unknown)", each figure with
 * its state; "value at spot: Prices off" while values at spot don't show.
 */
export function sourceMetaParts(source: Pick<MetalsHoldingSource, 'source' | 'units' | 'troyOz' | 'costMinor' | 'valueMinor'>,
  spot: GoldSpot = 'shown'): GoldLinePart[] {
  return [
    `${sourceName(source.source)} · ${plural(source.units, 'unit', 'units')} · `,
    { figure: ozFigure(source.troyOz), state: source.troyOz.state },
    ' · cost ',
    { figure: moneyFigure(source.costMinor), state: source.costMinor.state },
    ...(spot === 'shown'
      ? [' · value at spot ', { figure: moneyFigure(source.valueMinor), state: source.valueMinor.state }]
      : [` · value at spot: ${SPOT_OFF_WORDS[spot]}`]),
  ];
}

export type GoldPageView<T> =
  | { kind: 'not-installed' }
  | { kind: 'error' }
  | { kind: 'loading' }
  | { kind: 'nothing-imported' }
  | { kind: 'ledger'; overview: T };

/**
 * What the page shows for its overview read, in order: the set-up step when the ledger isn't installed (or the route is
 * missing), a failed read with nothing to show, the first read, then an installed ledger with no source imported yet
 * ("Nothing imported yet": nothing to count, so never a zero headline), and only then the ledger itself.
 */
export function goldPageView<T extends Pick<MetalsOverview, 'coverage'>>(
  read: { notInstalled: boolean; missing: boolean; error: string | null },
  shown: T | null,
): GoldPageView<T> {
  if (read.notInstalled || read.missing) return { kind: 'not-installed' };
  if (shown === null) return read.error ? { kind: 'error' } : { kind: 'loading' };
  return shown.coverage.length === 0 ? { kind: 'nothing-imported' } : { kind: 'ledger', overview: shown };
}

/** An order's refunds as the source shows them: shown, never linked to a card row. */
export function refundsText(refunds: MetalsPurchase['refunds']): string | null {
  if (refunds.length === 0) return null;
  return `${refunds.map((refund) => `${usd(Math.abs(refund.amountMinor))} refunded${refund.date ? ` on ${dateText(refund.date)}` : ''}`).join(' · ')}`
    + ' (the order\'s refunds as the store shows them; not linked to a card charge)';
}

export const QUARANTINE_TEXT = 'A later capture contradicts this order: its figures are partial, and it proves nothing until its '
  + 'records are reviewed.';
export const DATE_UNKNOWN_TEXT = 'A date this purchase counts is unknown, or only its year is inferred: figures as of a date treat it '
  + 'as partial.';

/** "Units 2 · 2.000 troy oz (you confirmed) · premium paid $45.00 per troy oz" as labelled parts. */
export function premiumText(purchase: MetalsPurchase): string | null {
  if (purchase.premiumPaidPerOzMinor === null || !purchase.purchaseSpot) return null;
  return `premium paid ${signedUsd(purchase.premiumPaidPerOzMinor).replace(/^\+/, '')} per troy oz over the spot at the close of `
    + `${dateText(purchase.purchaseSpot.closeDate)}, a proxy`;
}

const FUNDING_WORDS: Record<string, string> = {
  card: 'card', 'card-refund': 'card refund', 'shop-card': 'Costco Shop Card', 'gift-card': 'gift card',
  'store-balance': 'store balance', paypal: 'PayPal', debit: 'debit card', cash: 'cash', 'reward-certificate': 'reward certificate',
  coupon: 'coupon',
};
const NETWORK_WORDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };

/** "Paid with: Visa card $1,950.00 · Costco Shop Card $50.00" (never card digits). */
export function fundingText(funding: MetalsPurchase['funding']): string | null {
  if (funding.length === 0) return null;
  return funding.map((item) => {
    const network = item.kind === 'card' || item.kind === 'card-refund' || item.kind === 'debit' ? NETWORK_WORDS[item.network] : undefined;
    const kind = FUNDING_WORDS[item.kind] ?? item.kind;
    return `${network ? `${network} ${kind}` : capitalize(kind)}${item.amountMinor === null ? ' (amount not stated)' : ` ${usd(item.amountMinor)}`}`;
  }).join(' · ');
}

export const EVIDENCE_WORDS = {
  'costco-settled-tender@1': 'Costco\'s card payment on the order (costco-settled-tender@1)',
  'walmart-order-total@1': 'Walmart\'s order total on one card (walmart-order-total@1)',
} as const;

/** An account is always its name and its ending. */
export function accountText(account: { name: string; ending: string | null }): string {
  return account.ending ? `${account.name} ending ${account.ending}` : account.name;
}

/** One card subject of a purchase: a link (proof), a possible charge, or why it isn't linked. */
export function cardText(card: MetalsPurchaseCard): string {
  if (card.state === 'linked' && card.proof && card.row) {
    return `Paid by ${accountText(card.row.account)} · card charge of ${dateText(card.row.date)}`;
  }
  const why = card.state === 'linked' ? CARD_LINK_WHY.ineligible : CARD_LINK_WHY[card.state];
  if (card.row) {
    return `Possible card charge: ${accountText(card.row.account)} on ${dateText(card.row.date)}, not linked: ${why}`;
  }
  return `Card charge not linked: ${why}`;
}

/** Why an order whose card payments can never link has no card line of its own. */
export const AGGREGATE_CARD_TEXT = 'Card charge not linked: this order\'s card payments can\'t be told apart (several shipments or '
  + 'payments, a refund or a cancellation), so no single card charge proves it';

export function assignedText(purchase: MetalsPurchase): string | null {
  if (purchase.sales.length === 0) return null;
  return purchase.sales.map((sale) => `${sale.units === 1 ? '' : `${sale.units} units `}assigned to the sale of ${dateText(sale.agreedDate)}`)
    .map((text, index) => (index === 0 ? capitalize(text) : text)).join(' · ');
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const ASSIGNMENT_NOTE = 'Purchases assigned oldest first — not a confirmed physical match.';

// The owner's fungible policy (HOLDR_METALS_FUNGIBLE; contract `MetalsAssignmentMethod`): while it names a metal, that
// metal's purchases are assigned oldest first across all forms, a unit a sale took before its delivery was recorded
// counts as delivered, and the overview, purchases, sales and timeline carry `assignment`. Unset, no read carries it
// and every word below is as before.

/** Whether the owner's fungible policy names `metal`, as `read` (an overview, purchases, sales or timeline) carries it. */
export function fungibleFor(read: { assignment?: MetalsAssignmentMethod } | null | undefined, metal: Metal): boolean {
  return read?.assignment?.fungible.includes(metal) ?? false;
}

export const ASSIGNMENT_NOTE_FUNGIBLE = 'Purchases assigned oldest first across all forms (your rule) — not a confirmed physical match.';

/** A sale's assignment note: across all forms where the owner's policy names its metal. */
export const assignmentNote = (fungible: boolean) => (fungible ? ASSIGNMENT_NOTE_FUNGIBLE : ASSIGNMENT_NOTE);

/** The method behind every assignment, as "Where these figures come from" declares it. */
export function assignmentMethodText(fungible: boolean): string {
  return fungible
    ? `${ASSIGNMENT_NOTE_FUNGIBLE} Within each kind of item (metal and fine content per unit, every form together), the earliest `
      + 'purchase not yet assigned goes to each sale; a unit a sale took before its delivery was recorded counts as delivered from '
      + 'the day the sale was agreed.'
    : `${ASSIGNMENT_NOTE} Within each kind of item (metal, form and fine content per unit), the earliest purchase not yet assigned `
      + 'goes to each sale.';
}

/** A class's units counted delivered only because a sale took them (the owner's fungible policy). */
export function deliveryInferredText(units: number): string {
  return units === 1
    ? '1 unit counts as delivered because a sale took it (your rule); no delivery is recorded for it'
    : `${units} units count as delivered because a sale took them (your rule); no delivery is recorded for them`;
}

/** Holdings' classes heading: by form, or, where the owner's policy names the metal, by fine content across forms. */
export const holdingsClassesTitle = (fungible: boolean) => (fungible ? 'By fine content, all forms together (your rule)' : 'By form');

/** The sale's deposit state, summed over its payouts. */
export function depositSummary(payouts: readonly MetalsSalePayout[]): string {
  if (payouts.length === 0) return 'No payout';
  if (payouts.every((payout) => payout.deposit.state === 'linked' && payout.deposit.proof)) return 'Deposit linked';
  if (payouts.every((payout) => payout.deposit.state === 'linked' || payout.deposit.state === 'possible')) return 'Possible deposit';
  return 'Deposit not linked';
}

export function saleSummary(sale: MetalsSale): string {
  return `${usd(sale.netMinor)} net · ${depositSummary(sale.payouts)}`;
}

/** One payout: "paid to Sample Checking ending 0001 on Mar 4, 2026", a possible deposit, or why it isn't linked. */
export function payoutText(payout: MetalsSalePayout): string {
  const amount = usd(payout.amountMinor);
  const when = payout.payoutDate ? ` on ${dateText(payout.payoutDate)}` : '';
  const { deposit } = payout;
  if (deposit.state === 'linked' && deposit.proof && deposit.row) return `${amount} paid to ${accountText(deposit.row.account)}${when}`;
  if (deposit.state === 'possible' && deposit.row) {
    return `${amount} paid out${when} · Possible deposit: ${accountText(deposit.row.account)} on ${dateText(deposit.row.date)}, not confirmed as this payout`;
  }
  const state = deposit.state === 'linked' ? 'ineligible' : deposit.state;
  return `${amount} paid out${when} · Deposit not linked: ${depositWhy(state, deposit.coveredThrough)}`;
}

export function saleSpotText(sale: MetalsSale): string | null {
  if (!sale.saleSpot) return null;
  return sale.saleSpot.basis === 'dealer-implied'
    ? 'dealer\'s implied spot (sale)'
    : `close of ${dateText(sale.saleSpot.closeDate)}, a proxy (sale)`;
}

/** A cycle's spot line: the sale's spot, then the purchase's. */
export function cycleSpotText(sale: MetalsSale, purchaseSpot: { closeDate: string } | null): string | null {
  const parts = [saleSpotText(sale), purchaseSpot ? `close of ${dateText(purchaseSpot.closeDate)}, a proxy (purchase)` : null]
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * A sale's units with no recorded purchase, and why. While the owner's estimate switch gives them a cost (`estimate`), it
 * is said as estimated, with the purchase it is read from; otherwise their cost and result are unknown.
 */
export function unmatchedSaleText(sale: MetalsSale): string | null {
  if (sale.unmatched.units === 0) return null;
  const why = unmatchedReasonsText(sale.unmatched.reasons);
  const head = `${plural(sale.unmatched.units, 'unit has', 'units have')} no recorded purchase${why ? ` (${why})` : ''}`;
  const { estimate } = sale;
  if (!estimate) return `${head}: ${usd(sale.unmatched.netMinor)} of proceeds with unknown cost and result`;
  return `${head}. Estimated from your nearest purchase of the same kind (${dateText(estimate.from.orderDate)}, `
    + `${estimate.from.account.label}): cost ${usd(estimate.costMinor)}, result ${signedUsd(estimate.profitMinor)} on `
    + `${usd(estimate.proceedsMinor)} of proceeds, before rewards.`;
}

/**
 * A sale's assigned purchase: its profit or loss, before rewards like every realized result (ROOT, from the owner's
 * reaction), so it never reads as a final result.
 */
export const CYCLE_PROFIT_LABEL = 'Profit/loss before rewards';

export const SALE_STATUS_WORDS: Record<MetalsSale['status'], string> = {
  agreed: 'Agreed, not shipped yet',
  shipped: 'Shipped to the dealer',
  received: 'Received by the dealer',
  inspected: 'Inspected by the dealer',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

export function saleStatusText(sale: Pick<MetalsSale, 'status' | 'inspection'>): string {
  const status = SALE_STATUS_WORDS[sale.status];
  if (sale.inspection === 'failed') return `${status} · inspection failed`;
  if (sale.inspection === 'pending' && sale.status !== 'cancelled') return `${status} · inspection pending`;
  return status;
}

/** How a sale's profit or loss splits, said plainly beside the figures. */
export const DECOMPOSITION_NOTE = 'From spot-price change: what the move in the spot price between the purchase day and the sale '
  + 'day made or lost on these ounces. From premiums and fees: the rest, that is the premium paid over spot when buying, the '
  + 'dealer\'s price against spot when selling, and the fees.';

// ---------------------------------------------------------------------------
// The receipt block
// ---------------------------------------------------------------------------

/**
 * Receipt-confirmed charges (§10, G3's `receiptCharges`), named by metal: card charges linked as proof to an order whose
 * principal lines are all precious metal; a line naming several metals counts as "metal unclear". Evidence for the
 * owner, never a decision: they still count as spending.
 */
export function receiptCounts(purchases: readonly MetalsFundingPurchase[]): Array<{ metal: Metal | 'metal-unknown'; charges: number }> {
  const counts = new Map<Metal | 'metal-unknown', number>();
  for (const purchase of purchases) {
    for (const charge of purchase.receiptCharges) {
      for (const metal of new Set(charge.metals)) counts.set(metal, (counts.get(metal) ?? 0) + 1);
    }
  }
  return (['XAU', 'XAG', 'XPT', 'XPD', 'metal-unknown'] as const).filter((metal) => counts.has(metal))
    .map((metal) => ({ metal, charges: counts.get(metal)! }));
}

export function receiptText(counts: ReadonlyArray<{ metal: Metal | 'metal-unknown'; charges: number }>): string {
  return `Receipts show ${counts.map((entry) => `${entry.metal === 'metal-unknown' ? 'metal unclear' : metalName(entry.metal)} (${entry.charges})`)
    .join(' · ')}`;
}

export const RECEIPT_NOTE = 'Card charges linked to an order whose receipt is all precious metal. The receipts are evidence, not '
  + 'a decision: these charges still count as spending.';

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

export type GoldChartView = 'ounces' | 'value';
export const CHART_VIEW_LABELS: Record<GoldChartView, string> = { ounces: 'Troy oz held', value: 'Cost and value' };

/** A month button's accessible summary, each figure with its state; the value said as "Prices off" while values don't show. */
export function monthSentence(month: MetalsTimelineMonth, view: GoldChartView, spot: GoldSpot = 'shown'): string {
  const name = monthLabel(month.month);
  if (!month.recorded) return `${name}: not recorded`;
  if (view === 'ounces') {
    if (month.troyOz.value === null) return `${name}: troy oz held unknown`;
    const partial = month.troyOz.state === 'partial' ? ' (partial)' : '';
    return `${month.troyOz.value.display} troy oz held at the end of ${name}${partial}`;
  }
  const cost = month.costMinor.value === null ? 'cost unknown' : `cost ${withState(usd(month.costMinor.value), month.costMinor)}`;
  if (spot !== 'shown') return `At the end of ${name}: ${cost}, estimated value at spot: ${SPOT_OFF_WORDS[spot]}`;
  const notes = [month.valueMinor.state === 'partial' ? 'partial' : null, month.closeDate ? `close of ${dateText(month.closeDate)}` : null]
    .filter((note): note is string => note !== null);
  const value = month.valueMinor.value === null
    ? 'estimated value at spot unknown'
    : `estimated value at spot ${usd(month.valueMinor.value)}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
  return `At the end of ${name}: ${cost}, ${value}`;
}

const CHART_SERIES_WORDS = { ounces: '', cost: 'Cost ', value: 'Estimated value at spot ' } as const;

export type GoldChartSeries = 'ounces' | 'cost' | 'value';
/** The series each chart view draws, side by side in a month. */
export const CHART_SERIES: Record<GoldChartView, readonly GoldChartSeries[]> = { ounces: ['ounces'], value: ['cost', 'value'] };

/** The series a view draws on this page: no value series while values at spot don't show (cost alone, never a "?"). */
export function chartSeriesFor(view: GoldChartView, spot: GoldSpot): readonly GoldChartSeries[] {
  return spot === 'shown' ? CHART_SERIES[view] : CHART_SERIES[view].filter((series) => series !== 'value');
}

/**
 * A chart series in a month: its amount when known, its state and reasons. An unknown figure has no amount at all (it
 * is drawn as a marked "?", never a zero bar), and each series keeps its own state: cost and value never merge.
 */
export function chartSeriesOf(month: MetalsTimelineMonth, series: GoldChartSeries):
  { amount: number | null; state: MetalsMeasure<unknown>['state']; reasons: MetalsCompletenessReason[] } {
  if (series === 'ounces') {
    const { value, state, reasons } = month.troyOz;
    return { amount: value === null ? null : troyOzNumber(value), state: value === null ? 'unknown' : state, reasons };
  }
  const measure = series === 'cost' ? month.costMinor : month.valueMinor;
  return { amount: measure.value, state: measure.value === null ? 'unknown' : measure.state, reasons: measure.reasons };
}

/** A bar's height in percent of the scale's top, within 0 to 100. */
export function barHeight(amount: number, top: number): number {
  return top <= 0 ? 0 : Math.max(0, Math.min(100, (amount / top) * 100));
}

export type GoldChartMark =
  | { kind: 'gap' }
  | { kind: 'unknown'; series: GoldChartSeries }
  | { kind: 'bar'; series: GoldChartSeries; state: MetalsMeasure<unknown>['state']; height: number };

/**
 * How a month is drawn: a month no source covers is one gap; in a recorded month each series of the view is a bar of its
 * height (hatched when partial), or a marked "?" when no one knows it, never a bar of zero height.
 */
export function chartMarks(month: MetalsTimelineMonth, view: GoldChartView, top: number, spot: GoldSpot = 'shown'): GoldChartMark[] {
  if (!month.recorded) return [{ kind: 'gap' }];
  return chartSeriesFor(view, spot).map((series): GoldChartMark => {
    const { amount, state } = chartSeriesOf(month, series);
    return amount === null ? { kind: 'unknown', series } : { kind: 'bar', series, state, height: barHeight(amount, top) };
  });
}

/**
 * Under the chart, per series and state: "Unknown (?): Jan 2026 – Mar 2026, because no CNBC daily close for gold is
 * recorded." or "Partial (hatched): …". In the cost and value view each series is said apart ("Cost partial
 * (hatched): …", "Estimated value at spot unknown (?): …").
 */
export function chartCaption(view: GoldChartView, series: 'ounces' | 'cost' | 'value', state: 'unknown' | 'partial', months: string,
  why: readonly string[]): string {
  const mark = state === 'unknown' ? 'unknown (?)' : 'partial (hatched)';
  const label = view === 'ounces' ? capitalize(mark) : `${CHART_SERIES_WORDS[series]}${mark}`;
  return `${label}: ${months}${why.length > 0 ? `, because ${why.join('; ')}` : ''}.`;
}

// ---------------------------------------------------------------------------
// Confirming what a product contains
// ---------------------------------------------------------------------------

/** Rows that wait for the owner: a hold to answer, or details that differ from what was confirmed. */
export const toConfirm = (products: readonly MetalsProduct[]) => products.filter((product) => product.hold !== null);
/** Rows the owner answered, which can be undone. */
export const confirmed = (products: readonly MetalsProduct[]) => products.filter((product) => product.hold === null && product.decision !== null);
/**
 * "Confirm all as proposed": single products with a proposal only. A pack, a purchase whose pack is unclear, one with no
 * usable product reference (each scoped to its purchase) and details that drifted are confirmed one by one.
 */
export const confirmableAll = (products: readonly MetalsProduct[]) => toConfirm(products)
  .filter((product) => product.scope.kind === 'product' && product.pack === 'single' && product.proposal !== null && !product.drift);

/**
 * A content write the server refused, its product or decision not found or a conflict other than a stale preview: nothing
 * was saved and the product still waits for the owner (v0: said so, never "changed elsewhere").
 */
export const REFUSED_WRITE_TEXT = 'Nothing was saved: this product needs your answer: what it contains.';

/** The same for "Confirm all as proposed", after `done` products were saved. */
export function refusedBatchText(done: number): string {
  const rest = 'the products listed need your answer: what each contains.';
  return done > 0 ? `${plural(done, 'product was', 'products were')} confirmed. Nothing more was saved: ${rest}` : `Nothing was saved: ${rest}`;
}

const MASS_UNIT_WORDS: Record<string, string> = { ozt: 'troy oz', oz: 'oz', g: 'g', kg: 'kg' };

/** What its titles say: "1 oz · gold · bar · .9999". */
export function statedText(product: MetalsProduct): string {
  const { stated } = product;
  const parts = [
    stated.mass ? `${stated.mass.value} ${MASS_UNIT_WORDS[stated.mass.unit] ?? stated.mass.unit}` : 'no weight stated',
    stated.metal ? metalName(stated.metal) : 'metal not clear',
    stated.form ?? 'form not stated',
    stated.purity,
    stated.design ? `${stated.design.replace('-', ' ')} design` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

export function packText(product: Pick<MetalsProduct, 'pack' | 'packCount'>): string {
  if (product.pack === 'single') return 'One piece per unit';
  if (product.pack === 'multiple') return product.packCount ? `A pack of ${product.packCount} pieces per unit` : 'A pack of several pieces per unit';
  return 'The title doesn\'t show whether one unit is one piece';
}

/** "1 troy oz of fine gold per unit?" */
export function proposalQuestion(product: MetalsProduct, metal: Metal): string | null {
  if (!product.proposal) return null;
  const per = product.pack === 'multiple' ? 'per unit (the whole pack)' : 'per unit';
  return `${product.proposal.troyOzPerUnit.display} troy oz of fine ${metalName(product.proposal.metal ?? metal)} ${per}?`;
}

/** Whom a confirmation applies to: the product and later lines with the same details, or this one line. */
export function scopeText(product: MetalsProduct): string {
  const lines = [
    product.lots > 0 ? plural(product.lots, 'purchase', 'purchases') : null,
    product.saleLines > 0 ? plural(product.saleLines, 'sale', 'sales') : null,
  ].filter((part): part is string => part !== null).join(' and ');
  if (product.scope.kind === 'product') {
    return `Applies to ${lines || 'no purchase yet'} (${plural(product.units, 'unit', 'units')}) of this product, `
      + 'and to later ones with the same details.';
  }
  const why = product.scope.why === 'pack-multiple' ? 'A pack is confirmed on its own'
    : product.scope.why === 'pack-unknown' ? 'A purchase whose pack is unclear is confirmed on its own'
      : 'A purchase with no usable product reference is confirmed on its own';
  const one = product.saleLines > 0 && product.lots === 0 ? 'this sale' : 'this purchase';
  return `${why}: this applies to ${one} only (${plural(product.units, 'unit', 'units')}).`;
}

export const DRIFT_TEXT = 'Details differ from what you confirmed';

/** Parses what the owner typed: a positive decimal number of troy ounces, at most 7 decimals. */
export function parseTroyOzInput(text: string): string | null {
  const value = text.trim();
  if (!/^\d{1,4}(?:\.\d{1,7})?$/.test(value) || !/[1-9]/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}

/** What a row's lines are, as the preview counts them (it counts purchases and sales alike): [one, many]. */
export function linesNoun(product: Pick<MetalsProduct, 'lots' | 'saleLines'>): [string, string] {
  if (product.saleLines === 0) return ['purchase', 'purchases'];
  if (product.lots === 0) return ['sale', 'sales'];
  return ['purchase or sale', 'purchases and sales'];
}

export function previewText(preview: { lots: number; units: number; holdingsTroyOz: { before: MetalsMeasure<MetalsTroyOz>; after: MetalsMeasure<MetalsTroyOz> }; saleLines: number },
  undo = false, noun: [string, string] = ['purchase', 'purchases']): string {
  const lines = `${plural(preview.lots, noun[0], noun[1])} (${plural(preview.units, 'unit', 'units')})`;
  const parts = [
    undo ? `${lines} held again until confirmed` : `${lines} counted with this content`,
    `recorded holdings ${withState(ozFigure(preview.holdingsTroyOz.before), preview.holdingsTroyOz.before)} → `
      + `${withState(ozFigure(preview.holdingsTroyOz.after), preview.holdingsTroyOz.after)}`,
  ];
  if (preview.saleLines > 0) {
    const sales = preview.saleLines === 1 ? '1 sale line\'s' : `${preview.saleLines} sale lines'`;
    parts.push(`${sales} profit or loss ${undo ? 'unknown again' : 'becomes known'}`);
  }
  return `${undo ? 'Undoing would' : 'Confirming would'}: ${parts.join(' · ')}.`;
}

/**
 * One product of "Confirm all as proposed": what it covers, never holdings before and after, which each confirmation
 * changes for the next one.
 */
export function batchPreviewText(preview: { lots: number; units: number }, noun: [string, string] = ['purchase', 'purchases']): string {
  return `Would count ${plural(preview.lots, noun[0], noun[1])} (${plural(preview.units, 'unit', 'units')}) with this content.`;
}

export const BATCH_NOTE = 'They are confirmed one after another, each checked again just before it is saved; recorded holdings show '
  + 'the result once they are in.';

export function decisionText(product: MetalsProduct, metal: Metal): string | null {
  if (!product.decision) return null;
  return `You confirmed ${product.decision.troyOzPerUnit.display} troy oz of fine ${metalName(product.decision.metal ?? metal)} per unit `
    + `on ${dateText(product.decision.decidedAt.slice(0, 10))}`;
}

// ---------------------------------------------------------------------------
// Where these figures come from
// ---------------------------------------------------------------------------

const COVERAGE_KIND_WORDS: Record<string, string> = {
  online: 'online orders', warehouse: 'warehouse receipts', 'sell-orders': 'sell orders', payouts: 'payouts',
};

/** Per source account: the dates covered, complete or partial, when it was captured, and its held records. */
export function coverageLines(entry: MetalsCoverageEntry): string[] {
  const lines = entry.kinds.map((kind) => {
    const ranges = kind.ranges.length > 0 ? kind.ranges : [{ from: kind.from, to: kind.to }];
    const dates = ranges.map((range) => (range.from === range.to ? dateText(range.from) : `${dateText(range.from)} – ${dateText(range.to)}`)).join(', ');
    const state = kind.complete ? 'complete'
      : kind.stated === null ? `partial: ${kind.seen} read, no total stated` : `partial: ${kind.seen} of ${kind.stated} read`;
    return `${capitalize(COVERAGE_KIND_WORDS[kind.kind] ?? kind.kind)}: ${dates} · ${state}`;
  });
  lines.push(entry.capturedAt
    ? `Captured on ${dateText(entry.capturedAt.slice(0, 10))}, imported on ${dateText(entry.importedAt.slice(0, 10))}`
    : `Imported on ${dateText(entry.importedAt.slice(0, 10))}`);
  lines.push(entry.held === 0 ? 'No records held' : `${plural(entry.held, 'record', 'records')} held`);
  return lines;
}

/** The coverage kinds a source's holdings need (design v8 §5; payouts count for none): covered only through all of them. */
const HOLDING_KINDS: Record<MetalsSource, readonly string[]> = {
  costco: ['online', 'warehouse'], walmart: ['online'], collectpure: ['sell-orders'],
};

/**
 * Beside the as-of line, calmly: through which day each source's complete captures reach, "Costco: covered through
 * Nov 5, 2026 · Walmart: …". Holdings stay partial until a capture covers the day they are as of; that is no error. A
 * source is covered through the earliest last day of its accounts and kinds; one with a kind no complete capture covers
 * says so instead.
 */
export function coverageTail(coverage: readonly MetalsCoverageEntry[]): string | null {
  const sources = (Object.keys(SOURCE_NAMES) as MetalsSource[]).filter((source) => coverage.some((entry) => entry.source === source));
  if (sources.length === 0) return null;
  return sources.map((source) => {
    let through: string | null = null;
    let complete = true;
    for (const entry of coverage.filter((item) => item.source === source)) {
      for (const kind of HOLDING_KINDS[source]) {
        const ranges = entry.kinds.find((item) => item.kind === kind)?.ranges ?? [];
        const last = ranges.reduce<string | null>((latest, range) => (latest === null || range.to > latest ? range.to : latest), null);
        if (last === null) complete = false;
        else if (through === null || last < through) through = last;
      }
    }
    return complete && through !== null
      ? `${SOURCE_NAMES[source]}: covered through ${dateText(through)}`
      : `${SOURCE_NAMES[source]}: no complete capture yet`;
  }).join(' · ');
}

// ---------------------------------------------------------------------------
// The redesign's summary (Astra's accepted mock, round 4): one completeness line, held orders, troy oz
// ---------------------------------------------------------------------------

/**
 * The summary's one completeness line, over every figure it shows: the period's paid, brought in and profit or loss, and
 * what is held and its cost (value and gain too while values show). Each reason once, what waits for the owner said
 * instead of the bare codes (the page offers that action). Null when every figure is complete.
 */
export function summaryWarning(overview: MetalsOverview): string | null {
  const { activity: { bought, sold, profit }, holdings } = overview;
  const measures: Array<Pick<MetalsMeasure<unknown>, 'state' | 'reasons'>> = [
    bought.troyOz, bought.costMinor, sold.troyOz, sold.netMinor, profit.valueMinor, holdings.troyOz, holdings.costMinor,
  ];
  if (spotShown(overview.price) === 'shown') measures.push(holdings.valueMinor, holdings.gainMinor);
  const all = combined(...measures);
  if (all.state === 'complete') return null;
  const owner = ownerReasons(overview);
  const parts = [...new Set(all.reasons.map((reason) => owner[reason.code] ?? reasonText(reason, overview.metal)))];
  return parts.length > 0 ? `Totals are partial: ${parts.join(' · ')}` : 'Totals are partial';
}

/** Orders held until the owner answers whether their flagged lines are bullion (A0): information, no action here yet. */
export function heldForAnswerLine(overview: Pick<MetalsOverview, 'needsAnswer'>): string | null {
  const { orders } = overview.needsAnswer;
  if (orders === 0) return null;
  return `${plural(orders, 'order waits', 'orders wait')} for a bullion answer: held, not counted until then`;
}

/** Troy ounces as a secondary line: "4.000 troy oz (partial)", or why there is no figure. */
export function troyOzLine(measure: MetalsMeasure<MetalsTroyOz>): string {
  return measure.value === null ? 'troy oz unknown' : withState(troyOz(measure.value), measure);
}

// ---------------------------------------------------------------------------
// Products to confirm, grouped (Astra's round 3)
// ---------------------------------------------------------------------------

export interface GoldProductGroup {
  key: string;
  rows: MetalsProduct[];
  /** Purchase lines and sale lines its rows cover, and their units. */
  lots: number;
  saleLines: number;
  units: number;
}

/**
 * The products waiting for their contents, grouped by exact product and content. A product-wide row is its own group (its
 * ref and content fingerprint): one action. Purchase rows (a pack, an unclear pack, no usable or no unique product
 * reference) group only when their source, every title, every stated detail, the pack, the title's proposal and why they
 * are per purchase are all the same; each is still confirmed on its own (§11: packs per purchase). Different variants
 * never share a group. Most records first, then by title.
 */
export function productGroups(products: readonly MetalsProduct[]): GoldProductGroup[] {
  const groups = new Map<string, GoldProductGroup>();
  for (const row of products) {
    if (row.hold === null && !row.drift) continue;
    const { scope } = row;
    const key = scope.kind === 'product'
      ? `product|${scope.ref}|${scope.fingerprint}`
      : ['lot', row.source, row.titles.join('\u241F'), JSON.stringify(row.stated), row.pack,
        row.proposal ? `${row.proposal.metal}:${row.proposal.troyOzPerUnit.exact}` : '', scope.why].join('|');
    const group = groups.get(key) ?? { key, rows: [], lots: 0, saleLines: 0, units: 0 };
    group.rows.push(row);
    group.lots += row.lots;
    group.saleLines += row.saleLines;
    group.units += row.units;
    groups.set(key, group);
  }
  const title = (group: GoldProductGroup) => group.rows[0].titles[0]?.trim() ?? '';
  return [...groups.values()].sort((a, b) => (b.lots + b.saleLines) - (a.lots + a.saleLines) || title(a).localeCompare(title(b)) || a.key.localeCompare(b.key));
}

/** "affects 3 purchases and 2 sales": only the parts there are. */
export function affectsText(group: Pick<GoldProductGroup, 'lots' | 'saleLines'>): string {
  const parts = [
    group.lots > 0 ? plural(group.lots, 'purchase', 'purchases') : null,
    group.saleLines > 0 ? plural(group.saleLines, 'sale', 'sales') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `affects ${parts.join(' and ')}` : 'affects no recorded line yet';
}

/** The compact card's one line: how many products wait, and how many records they reach. */
export function confirmCardText(groups: readonly GoldProductGroup[]): string {
  const records = groups.reduce((total, group) => total + group.lots + group.saleLines, 0);
  return `${plural(groups.length, 'product waits', 'products wait')}, affecting ${plural(records, 'record', 'records')}: `
    + 'confirm contents to calculate more of your totals.';
}

// ---------------------------------------------------------------------------
// Price & your trades: daily closes per troy oz, each trade at its price per troy oz
// ---------------------------------------------------------------------------

/** The line connects stored closes up to this many days apart; daily prices in between are not shown. */
export const PRICE_JOIN_DAYS = 4;
const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** Stored closes as cents per troy oz, inside [start, end], ascending; an unreadable close is left out. */
export function closesInRange(closes: ReadonlyArray<{ date: string; close: string }>, start: string, end: string): Array<{ date: string; minor: number }> {
  return closes
    .flatMap((close) => {
      const dollars = Number(close.close);
      return close.date >= start && close.date <= end && /^\d+(\.\d+)?$/.test(close.close) && Number.isFinite(dollars)
        ? [{ date: close.date, minor: Math.round(dollars * 100) }]
        : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The price line over [start, end]: closes joined while at most `joinDays` apart, broken (a null point) across a longer
 * gap, which is listed to be shaded as no usable close; so is the start or end of the dates when more than `joinDays`
 * from the nearest close. With no close at all, the whole range is the gap.
 */
export function priceLine(points: ReadonlyArray<{ date: string; minor: number }>, start: string, end: string, joinDays = PRICE_JOIN_DAYS):
  { points: Array<{ date: string; value: number | null }>; gaps: Array<{ from: string; to: string }> } {
  const line: Array<{ date: string; value: number | null }> = [];
  const gaps: Array<{ from: string; to: string }> = [];
  if (points.length === 0) return { points: line, gaps: [{ from: start, to: end }] };
  if (dayNumber(points[0].date) - dayNumber(start) > joinDays) gaps.push({ from: start, to: points[0].date });
  points.forEach((point, index) => {
    const before = index === 0 ? null : points[index - 1];
    if (before && dayNumber(point.date) - dayNumber(before.date) > joinDays) {
      line.push({ date: before.date, value: null });
      gaps.push({ from: before.date, to: point.date });
    }
    line.push({ date: point.date, value: point.minor });
  });
  const last = points[points.length - 1];
  if (dayNumber(end) - dayNumber(last.date) > joinDays) gaps.push({ from: last.date, to: end });
  return { points: line, gaps };
}

/** The price chart's own first date: the period's, or for all history the earliest close or trade it shows. */
export function priceChartStart(from: string | null, dates: readonly string[], to: string): string {
  if (from !== null) return from;
  return [...dates].sort()[0] ?? to;
}

/** A trade's price per troy oz in cents: what it cost or brought in over its fine ounces; null when either is unknown. */
export function pricePerTroyOz(moneyMinor: number | null, troyOzPerUnit: MetalsTroyOz | null, quantity: number): number | null {
  if (moneyMinor === null || troyOzPerUnit === null || quantity <= 0) return null;
  const [numerator, denominator] = troyOzPerUnit.exact.split('/');
  const ounces = (Number(numerator) / Number(denominator ?? '1')) * quantity;
  return Number.isFinite(ounces) && ounces > 0 ? Math.round(moneyMinor / ounces) : null;
}
