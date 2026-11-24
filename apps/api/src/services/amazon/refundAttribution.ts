import { itemBlockReconciles } from './allocation.js';
import { currency as isCurrency, day, digest, minor } from './policy.js';
import type { Money, OrderObservation } from './types.js';

/**
 * Which of an Amazon order's items its refunds paid back, from evidence only. Pure: no database, clock or network, so
 * Amazon's own net view (an order's refunds together) and Spending's card credits (one refund payment) decide alike.
 *
 * A refund is tied to items only when the evidence proves which:
 * - **whole order**: the refund equals the order's Grand Total, so every item came back;
 * - **item records**: Amazon's own item-level refund records, every one resolved to the order's lines;
 * - **units**: the refund equals the prices of exactly one set of the order's units plus their share of its tax, to
 *   within tax rounding, and no other set of its units comes within that margin. It needs the order's item list
 *   proven complete (another line could be the refunded one) and no promotion (an item's share of one is unknown);
 *   one refund payment also needs a single card to have paid the order (else it may be a tender's share);
 * - **only line**: the order's item list is proven complete and has one line, so any refund is that line's, taken off
 *   it up to its price (the rest is its tax and the order's shipping).
 * Anything else stays an order-level refund "not attributed to items", with the first rule that held as its reason.
 *
 * Evidence that contradicts itself or the order (another currency, more than the order's total, one ledger occurrence
 * read two ways, a Refund Total that went down) is left out and counted, never guessed around. Nothing is converted.
 */
export const REFUND_ATTRIBUTION_POLICY = Object.freeze({
  version: 'amazon-refund-attribution-v1',
  window: 'order-date',
  orderRefund: 'largest-of-refund-total-ledger-and-item-records-never-summed',
  refundTotal: 'nondecreasing-across-observations-latest',
  ledgerIdentity: 'orders-currency-amount-most-occurrences-in-one-run',
  wholeOrder: 'refund-equals-grand-total',
  itemRecords: 'every-record-resolved-consistent-units',
  units: 'unique-unit-set-price-plus-tax-share-half-cent-per-unit-and-line',
  onlyLine: 'proven-single-line-capped-at-line-price',
  unattributed: 'lowers-net-capped-at-order-unrefunded-item-prices',
});
export const REFUND_ATTRIBUTION_POLICY_DIGEST = digest(REFUND_ATTRIBUTION_POLICY);
/** Unit combinations the search may visit before it holds rather than claim that no other set matches. */
export const REFUND_SEARCH_LIMIT = 100_000;

/** Why a refund is not tied to items: the first rule that held. */
export const REFUND_HOLD_REASONS = ['invalid-amount', 'order-total-missing', 'currency-mismatch', 'exceeds-order-total',
  'items-unproven', 'promotion', 'mixed-tender', 'summary-incomplete', 'no-match', 'ambiguous', 'search-limit'] as const;
export type RefundHoldReason = (typeof REFUND_HOLD_REASONS)[number];
/**
 * Why refund evidence was left out of an order's refunds altogether: it is counted, never used. `ambiguous-repeat`: a
 * ledger row identical to another in the same run, which may be the same refund shown twice; one of them counts.
 */
export const REFUND_EXCLUSION_REASONS = ['currency-mismatch', 'exceeds-order-total', 'multiple-orders', 'contradictory',
  'invalid', 'ambiguous-repeat', 'unresolved'] as const;
export type RefundExclusionReason = (typeof REFUND_EXCLUSION_REASONS)[number];
/** Why an order's counted refund is (partly) not tied to items. */
export type UnattributedReason = RefundHoldReason | 'conflict';
export const UNATTRIBUTED_REASONS: readonly UnattributedReason[] = [...REFUND_HOLD_REASONS, 'conflict'];

/**
 * `payment`: one refund payment (a ledger refund, a card credit), which with split tender may be one tender's share.
 * `order-total`: all of an order's refunds together (Amazon's Refund Total, or every refund of it).
 */
export type RefundScope = 'payment' | 'order-total';
export interface RefundUnits { lineOrdinal: number; units: number }
export type RefundMatch =
  | { kind: 'whole-order'; lines: RefundUnits[] }
  | { kind: 'units'; lines: RefundUnits[] }
  | { kind: 'only-line'; lineOrdinal: number }
  | { kind: 'held'; reason: RefundHoldReason };
export type RefundSplit =
  | { kind: 'split'; basis: 'whole-order' | 'units' | 'only-line';
    lines: Array<{ lineOrdinal: number; units: number | null; amountMinor: number }> }
  | { kind: 'held'; reason: RefundHoldReason };

export interface PricedLine { lineOrdinal: number; quantity: number; price: bigint }
export type Search = { kind: 'unique'; units: RefundUnits[] } | { kind: 'none' } | { kind: 'ambiguous' } | { kind: 'limit' };

const isOrdinal = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 99;
const isQuantity = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const validMoney = (money: Money | null | undefined): money is Money => !!money && isCurrency(money.currency) && minor(money.amountMinor);
const byOrdinal = (a: { lineOrdinal: number }, b: { lineOrdinal: number }) => a.lineOrdinal - b.lineOrdinal;

/** The order's Grand Total, if it has a positive one. */
function grandTotal(order: OrderObservation): Money | null {
  return validMoney(order.total) && order.total.amountMinor > 0 ? order.total : null;
}

/** A proven order's subtotal, tax and promotion, each listed once; null when any of them is unusable. */
export function taxBasis(order: OrderObservation, currency: string): { subtotal: bigint; tax: bigint; promotion: bigint } | null {
  const summary = order.summary ?? [];
  if (new Set(summary.map(s => s.kind)).size !== summary.length) return null;
  const amount = (kind: string) => summary.find(s => s.kind === kind)?.money;
  const subtotal = amount('items-subtotal'), tax = amount('tax'), promotion = amount('promotion');
  if (!validMoney(subtotal) || subtotal.currency !== currency || subtotal.amountMinor <= 0
    || !validMoney(tax) || tax.currency !== currency || tax.amountMinor < 0
    || (promotion !== undefined && (!validMoney(promotion) || promotion.currency !== currency))) return null;
  return { subtotal: BigInt(subtotal.amountMinor), tax: BigInt(tax.amountMinor), promotion: BigInt(promotion?.amountMinor ?? 0) };
}

export function pricedLines(order: OrderObservation): PricedLine[] {
  // Called only on an order whose item block reconciles: every line has an ordinal, a quantity and a price.
  return order.items.map(item => ({ lineOrdinal: item.lineOrdinal!, quantity: item.quantity!, price: BigInt(item.unitPrice!.amountMinor) }));
}

/**
 * The one set of units whose prices plus their share of the order's tax (tax × prices / subtotal) come to `amount`,
 * within half a cent per unit refunded and per priced line of the order (each line's tax was rounded, and so was the
 * refund's): |2 × (amount × subtotal − prices × (subtotal + tax))| ≤ (units + lines) × subtotal. A tax-free order
 * must match to the cent. Free lines are never candidates. Two matching sets are ambiguous; a search that would visit
 * more than REFUND_SEARCH_LIMIT combinations holds rather than claim there is no other. `orderLines`: the order's
 * priced lines, when only some of them are candidates (their tax was rounded all the same).
 */
export function searchUnits(lines: readonly PricedLine[], subtotal: bigint, tax: bigint, amount: bigint, orderLines?: number): Search {
  const candidates = lines.filter(line => line.price > 0n)
    .sort((a, b) => (a.price === b.price ? a.lineOrdinal - b.lineOrdinal : a.price > b.price ? -1 : 1));
  if (!candidates.length) return { kind: 'none' };
  const n = BigInt(orderLines ?? candidates.length), gross = subtotal + tax;
  const matches = (price: bigint, units: bigint) => units > 0n && (tax === 0n ? price === amount
    : abs(2n * (amount * subtotal - price * gross)) <= (units + n) * subtotal);
  // More units only add to both sides, the prices by at least twice the margin: once too much, always too much.
  const tooMuch = (price: bigint, units: bigint) => (tax === 0n ? price > amount
    : 2n * (price * gross - amount * subtotal) > (units + n) * subtotal);
  const restPrice: bigint[] = new Array(candidates.length + 1).fill(0n);
  const restUnits: bigint[] = new Array(candidates.length + 1).fill(0n);
  for (let i = candidates.length - 1; i >= 0; i--) {
    restPrice[i] = restPrice[i + 1] + BigInt(candidates[i].quantity) * candidates[i].price;
    restUnits[i] = restUnits[i + 1] + BigInt(candidates[i].quantity);
  }
  // Even every remaining unit can't reach the amount, at the widest margin they could allow.
  const tooLittle = (price: bigint, units: bigint, i: number) => {
    const most = price + restPrice[i], all = units + restUnits[i];
    return tax === 0n ? most < amount : 2n * (amount * subtotal - most * gross) > (all + n) * subtotal;
  };
  const chosen = new Array<number>(candidates.length).fill(0);
  const search: { visits: number; count: number; found: RefundUnits[] | null; stopped: 'ambiguous' | 'limit' | null } =
    { visits: 0, count: 0, found: null, stopped: null };
  const walk = (i: number, price: bigint, units: bigint): void => {
    if (search.stopped) return;
    if (++search.visits > REFUND_SEARCH_LIMIT) { search.stopped = 'limit'; return; }
    if (tooMuch(price, units) || tooLittle(price, units, i)) return;
    if (i === candidates.length) {
      if (!matches(price, units)) return;
      if (++search.count > 1) { search.stopped = 'ambiguous'; return; }
      search.found = chosen.map((k, index) => ({ lineOrdinal: candidates[index].lineOrdinal, units: k }))
        .filter(entry => entry.units > 0).sort(byOrdinal);
      return;
    }
    const line = candidates[i];
    for (let k = 0; k <= line.quantity && !search.stopped; k++) {
      const nextPrice = price + BigInt(k) * line.price, nextUnits = units + BigInt(k);
      if (k > 0 && tooMuch(nextPrice, nextUnits)) break;
      chosen[i] = k;
      walk(i + 1, nextPrice, nextUnits);
    }
    chosen[i] = 0;
  };
  walk(0, 0n, 0n);
  if (search.stopped) return { kind: search.stopped };
  return search.found ? { kind: 'unique', units: search.found } : { kind: 'none' };
}

/**
 * Which of `order`'s units one refund paid back (see the module's rules). `refund` may carry either sign: its size
 * is what counts. Only `whole-order` is decided without the order's item list proven complete, since every line it
 * kept came back; it lists every line with an ordinal and a quantity.
 */
export function matchRefund(order: OrderObservation, refund: Money, scope: RefundScope): RefundMatch {
  const held = (reason: RefundHoldReason): RefundMatch => ({ kind: 'held', reason });
  if (!validMoney(refund) || refund.amountMinor === 0) return held('invalid-amount');
  const amount = Math.abs(refund.amountMinor), total = grandTotal(order);
  if (!total) return held('order-total-missing');
  if (refund.currency !== total.currency) return held('currency-mismatch');
  if (amount > total.amountMinor) return held('exceeds-order-total');
  if (amount === total.amountMinor) {
    return { kind: 'whole-order', lines: order.items.flatMap(item => isOrdinal(item.lineOrdinal) && isQuantity(item.quantity)
      ? [{ lineOrdinal: item.lineOrdinal, units: item.quantity }] : []).sort(byOrdinal) };
  }
  if (!itemBlockReconciles(order)) return held('items-unproven');
  if (order.items.some(item => item.unitPrice!.currency !== total.currency)) return held('currency-mismatch');
  const only = order.items.length === 1 ? order.items[0].lineOrdinal! : null;
  const otherwise = (reason: RefundHoldReason): RefundMatch => (only === null ? held(reason) : { kind: 'only-line', lineOrdinal: only });
  const basis = taxBasis(order, total.currency);
  if (!basis) return otherwise('summary-incomplete');
  if (basis.promotion !== 0n) return otherwise('promotion');
  if (scope === 'payment' && order.tenderCoverage !== 'single-card-proven') return otherwise('mixed-tender');
  const found = searchUnits(pricedLines(order), basis.subtotal, basis.tax, BigInt(amount));
  if (found.kind === 'unique') return { kind: 'units', lines: found.units };
  return otherwise(found.kind === 'none' ? 'no-match' : found.kind === 'ambiguous' ? 'ambiguous' : 'search-limit');
}

// STEP 9 integration (B5)
/**
 * Integer shares of `total` by weight, the remainder to the largest fractions, ties to the lower line ordinal. STEP 9
 * integration B5 (Root): a caller may give each line a stable tie key (`ties`, order-history v3's lineTieKeys); a tie
 * then goes to the lower key, as the charge allocations' largest remainder does.
 * STEP 9 integration B5 (Root): keys count only when every line has its own; else there is no order to go by (null),
 * never keys mixed with ordinals pair by pair, which order no tie totally.
 */
function shares(total: bigint, weights: ReadonlyArray<{ lineOrdinal: number; weight: bigint }>,
  ties?: ReadonlyMap<number, string>): Map<number, bigint> | null {
  if (ties && (weights.some(w => !ties.has(w.lineOrdinal))
    || new Set(weights.map(w => ties.get(w.lineOrdinal))).size !== weights.length)) return null;
  const denominator = weights.reduce((sum, w) => sum + w.weight, 0n);
  const parts = weights.map(w => ({ lineOrdinal: w.lineOrdinal, units: total * w.weight / denominator,
    remainder: total * w.weight % denominator }));
  let left = total - parts.reduce((sum, p) => sum + p.units, 0n);
  const tied = (a: { lineOrdinal: number }, b: { lineOrdinal: number }) =>
    (ties ? (ties.get(a.lineOrdinal)! < ties.get(b.lineOrdinal)! ? -1 : 1) : a.lineOrdinal - b.lineOrdinal);
  parts.sort((a, b) => (a.remainder === b.remainder ? tied(a, b) : a.remainder > b.remainder ? -1 : 1));
  for (const part of parts) if (left > 0n) { part.units++; left--; }
  return new Map(parts.map(p => [p.lineOrdinal, p.units]));
}

/**
 * One refund's money over the lines it paid back, for a card credit's item parts: positive amounts that add up to
 * exactly its size, by the refunded units' prices (largest remainder, ties to the lower ordinal, or to the lower of the
 * caller's stable `ties` keys), all of it on the only line. A money split needs the order's item list proven complete on
 * every basis, whole order included: over a partial list it would put an uncaptured line's money on the captured ones.
 * Zero shares are left out.
 * STEP 9 integration B5 (Root): given `ties`, a line without its own key holds the split (items-unproven, an existing
 * reason): no tie is broken.
 */
export function splitRefund(order: OrderObservation, refund: Money, scope: RefundScope,
  ties?: ReadonlyMap<number, string>): RefundSplit {
  const match = matchRefund(order, refund, scope);
  if (match.kind === 'held') return match;
  if (!itemBlockReconciles(order)) return { kind: 'held', reason: 'items-unproven' };
  const amount = BigInt(Math.abs(refund.amountMinor));
  if (match.kind === 'only-line') {
    return { kind: 'split', basis: 'only-line', lines: [{ lineOrdinal: match.lineOrdinal, units: null, amountMinor: Number(amount) }] };
  }
  const prices = new Map(pricedLines(order).map(line => [line.lineOrdinal, line.price]));
  const weights = match.lines.map(line => ({ lineOrdinal: line.lineOrdinal, units: line.units,
    weight: BigInt(line.units) * (prices.get(line.lineOrdinal) ?? 0n) })).filter(w => w.weight > 0n);
  if (!weights.length) return { kind: 'held', reason: 'no-match' };
  // STEP 9 integration (B5)
  const parts = shares(amount, weights, ties);
  if (!parts) return { kind: 'held', reason: 'items-unproven' }; // STEP 9 integration B5 (Root): no stable key for every line
  return { kind: 'split', basis: match.kind, lines: weights.map(w => ({ lineOrdinal: w.lineOrdinal, units: w.units,
    amountMinor: Number(parts.get(w.lineOrdinal)!) })).filter(line => line.amountMinor > 0) };
}

/** One observation of a payments-ledger row: whatever it showed, and what it showed of a refund. */
export interface LedgerRefundObservation {
  /** The run that saw it (its UUID), else its capture's digest: a ledger row's page and ordinal are distinct only within one. */
  run: string;
  page: number;
  ordinal: number;
  /** A digest of everything the observation shows: two different ones of one row contradict each other. */
  evidence: string;
  /** What a completed ledger `Refunded` refund shows; null for any other row seen there (a charge, a pending row). */
  refund: { date: string; money: Money; orderIds: readonly string[]; repeat: boolean } | null;
}
/** The distinct ledger refunds of one size for one set of orders. */
export interface LedgerRefundGroup {
  /** Sorted and distinct: one order for a refund that can be tied to an order. */
  orderIds: string[];
  currency: string;
  /** Its size, positive whatever sign the ledger showed. */
  amountMinor: number;
  /** How many distinct refunds: the most occurrences any one run showed, so a repeat across captures counts once. */
  events: number;
  /** Their dates as that run showed them, earliest first. Shown only; windows go by order date. */
  dates: string[];
  /** Every observation behind them, repeats across captures included. */
  observations: number;
  /**
   * Rows a run showed identically to another of its rows (the most any one run showed): each may be the same refund
   * shown twice, so only one of them counts, and these are left out as `ambiguous-repeat`.
   */
  ambiguousRepeats: number;
}
export interface LedgerRefundExclusion { orderIds: string[]; reason: 'contradictory' | 'invalid'; observations: number }

/**
 * Ledger refunds, each counted once. Captures repeat the ledger's rows, and no stable refund ID exists, so a refund's
 * identity is its orders, currency and size: within one run, distinct rows (page, ordinal) are distinct refunds,
 * except rows the ledger showed identically (`repeat`), which may be one refund shown twice: exactly one of them
 * counts, the provable minimum, and the others are counted apart (`ambiguousRepeats`), never added; across
 * runs, the same refund shows again, so a size counts as many times as the run that showed it most. Leaving the date
 * out can only merge refunds, never split one: a repeat is never counted twice, and two equal refunds count twice
 * only once one run shows both. A row read two ways (a refund and something else, or two different refunds) is
 * contradictory; a refund without a currency, a nonzero size, an order or a date is invalid. Both are left out.
 */
export function dedupeLedgerRefunds(observations: readonly LedgerRefundObservation[]): {
  groups: LedgerRefundGroup[]; excluded: LedgerRefundExclusion[];
} {
  const occurrences = new Map<string, LedgerRefundObservation[]>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.run, observation.page, observation.ordinal]);
    const list = occurrences.get(key) ?? [];
    list.push(observation);
    occurrences.set(key, list);
  }
  const excluded: LedgerRefundExclusion[] = [];
  const orderIdsOf = (refunds: readonly LedgerRefundObservation[]) => [...new Set(refunds.flatMap(o =>
    (Array.isArray(o.refund!.orderIds) ? o.refund!.orderIds : [])).filter((id): id is string => typeof id === 'string'))].sort();
  const groups = new Map<string, { orderIds: string[]; currency: string; amountMinor: number; observations: number;
    runs: Map<string, { native: string[]; repeats: Map<string, { date: string; occurrences: number }> }> }>();
  const ordered = [...occurrences].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, list]) => list);
  for (const list of ordered) {
    const refunds = list.filter(o => o.refund !== null);
    if (!refunds.length) continue;
    if (new Set(list.map(o => o.evidence)).size > 1) {
      excluded.push({ orderIds: orderIdsOf(refunds), reason: 'contradictory', observations: refunds.length });
      continue;
    }
    const refund = refunds[0].refund!;
    const orderIds = orderIdsOf(refunds);
    if (!validMoney(refund.money) || refund.money.amountMinor === 0 || !day(refund.date) || !Array.isArray(refund.orderIds)
      || !orderIds.length || refund.orderIds.some(id => typeof id !== 'string' || !id)) {
      excluded.push({ orderIds, reason: 'invalid', observations: refunds.length });
      continue;
    }
    const amountMinor = Math.abs(refund.money.amountMinor);
    const id = JSON.stringify([orderIds, refund.money.currency, amountMinor]);
    const group = groups.get(id) ?? { orderIds, currency: refund.money.currency, amountMinor, observations: 0, runs: new Map() };
    group.observations += refunds.length;
    const run = group.runs.get(refunds[0].run) ?? { native: [], repeats: new Map<string, { date: string; occurrences: number }>() };
    // Rows the ledger showed identically may be one refund shown twice: within a run, one of them counts.
    if (refund.repeat) {
      const repeat = run.repeats.get(refunds[0].evidence) ?? { date: refund.date, occurrences: 0 };
      repeat.occurrences++;
      run.repeats.set(refunds[0].evidence, repeat);
    } else run.native.push(refund.date);
    group.runs.set(refunds[0].run, run);
    groups.set(id, group);
  }
  return {
    groups: [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, group]) => {
      let best: string[] = [], ambiguousRepeats = 0;
      for (const [, run] of [...group.runs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const dates = [...run.native, ...[...run.repeats.values()].map(repeat => repeat.date)].sort();
        if (dates.length > best.length) best = dates;
        const extra = [...run.repeats.values()].reduce((sum, repeat) => sum + repeat.occurrences - 1, 0);
        if (extra > ambiguousRepeats) ambiguousRepeats = extra;
      }
      return { orderIds: group.orderIds, currency: group.currency, amountMinor: group.amountMinor, events: best.length,
        dates: best, observations: group.observations, ambiguousRepeats };
    }),
    excluded,
  };
}

/**
 * An order's Refund Total (`refundSummary`, Amazon's own figure on the order's page), each observation of it oldest
 * first, counted once: the latest, since a total only grows as refunds are issued. One that went down, or changed
 * currency, contradicts another and the total is left out; a malformed one is invalid.
 */
export type OrderRefundTotal =
  | { kind: 'total'; money: Money; observations: number }
  | { kind: 'contradictory' | 'invalid'; observations: number };
export function orderRefundTotal(observed: readonly Money[]): OrderRefundTotal | null {
  if (!observed.length) return null;
  const observations = observed.length;
  if (observed.some(money => !validMoney(money) || money.amountMinor < 0)) return { kind: 'invalid', observations };
  if (new Set(observed.map(money => money.currency)).size > 1
    || observed.some((money, i) => i > 0 && money.amountMinor < observed[i - 1].amountMinor)) {
    return { kind: 'contradictory', observations };
  }
  return { kind: 'total', money: { ...observed[observations - 1] }, observations };
}

/** One of Amazon's own item-level refund records for an order: a completed refund, its stated money and items. */
export interface ItemRefundRecord {
  money: Money | null;
  /** The order's lines it names; `units` only when Amazon stated how many. */
  lines: ReadonlyArray<{ lineOrdinal: number; units: number | null }>;
}
export interface OrderRefundEvidence {
  /** Every observation of the order's Refund Total, oldest first (see orderRefundTotal). */
  summaries: readonly Money[];
  /** One entry per distinct ledger refund of this order alone (dedupeLedgerRefunds), as a positive size. */
  ledger: readonly Money[];
  /** Amazon's item-level refund records for the order, each counted once. */
  itemRecords?: readonly ItemRefundRecord[];
}
export type RefundSource = 'order-summary' | 'ledger' | 'item-records';
export type RefundBasis = 'whole-order' | 'item-records' | 'units' | 'only-line' | 'partly' | 'unattributed';
export interface OrderRefundAttribution {
  currency: string | null;
  /**
   * The refund money counted for the order: the largest of its Refund Total, its ledger refunds and its item records'
   * stated money. Each is a total of refunds already issued, so they are never added together. 0: no refund.
   */
  refundMinor: number;
  /** Which evidence that amount is (Amazon's Refund Total when two agree). */
  source: RefundSource | null;
  basis: RefundBasis | null;
  /**
   * The lines refunds were tied to, by ordinal: whole units refunded, or for a refund of the order's only line, the
   * money taken off it (`moneyMinor`, at most the line's price).
   */
  lines: Array<{ lineOrdinal: number; units: number; moneyMinor: number }>;
  /** Refund money tied to no item. The view takes it off the total, at most what the order's items still cost. */
  unattributedMinor: number;
  unattributedReason: UnattributedReason | null;
  /** Evidence left out, never counted: how many refund records, by source and reason. */
  excluded: Array<{ source: RefundSource; reason: RefundExclusionReason; count: number }>;
}

/** Resolved item records: units per line, the money they state, and the units whose money they don't state. */
interface ResolvedRecords {
  units: Map<number, number>;
  stated: bigint;
  /** Records without money: their units' prices, and the tax basis that gives those units their share of tax. */
  moneyless: { prices: bigint; units: bigint; subtotal: bigint; tax: bigint; lines: bigint } | null;
}
/**
 * Item records resolved to units per line: units Amazon stated, else 1 for a line of one, else the one unit count
 * whose prices plus tax share match the record's money. Two records naming one line may be the same units restated or
 * more of them, so their units and money can't be proven to agree: then none resolves. A record without money resolves
 * only on an order whose tax basis gives its units their share of tax (no promotion), so the money it accounts for is
 * conserved. Null when any record can't be resolved; 'conflict' when one names more units than were ordered.
 */
function resolveRecords(order: OrderObservation, records: readonly ItemRefundRecord[], currency: string):
  ResolvedRecords | 'conflict' | null {
  const items = new Map(order.items.filter(item => isOrdinal(item.lineOrdinal) && isQuantity(item.quantity))
    .map(item => [item.lineOrdinal!, item]));
  const units = new Map<number, number>();
  let stated = 0n, moneylessPrices = 0n, moneylessUnits = 0n;
  for (const record of records) {
    if (!record.lines.length) return null;
    let prices = 0n;
    for (const line of record.lines) {
      const item = items.get(line.lineOrdinal);
      if (!item || units.has(line.lineOrdinal)) return null;
      let count = line.units ?? (item.quantity === 1 ? 1 : null);
      if (count === null && record.lines.length === 1 && record.money && itemBlockReconciles(order)) {
        const basis = taxBasis(order, record.money.currency);
        const lines = pricedLines(order);
        const found = basis && basis.promotion === 0n && item.unitPrice!.currency === record.money.currency
          ? searchUnits(lines.filter(l => l.lineOrdinal === line.lineOrdinal), basis.subtotal, basis.tax,
            BigInt(record.money.amountMinor), lines.filter(l => l.price > 0n).length) : null;
        if (found?.kind === 'unique') count = found.units[0].units;
      }
      if (!isQuantity(count)) return null;
      if (count > item.quantity!) return 'conflict';
      units.set(line.lineOrdinal, count);
      if (!record.money) {
        if (!validMoney(item.unitPrice) || item.unitPrice.currency !== currency) return null;
        prices += BigInt(count) * BigInt(item.unitPrice.amountMinor);
        moneylessUnits += BigInt(count);
      }
    }
    if (record.money) stated += BigInt(record.money.amountMinor);
    else moneylessPrices += prices;
  }
  if (moneylessUnits === 0n) return { units, stated, moneyless: null };
  const basis = taxBasis(order, currency);
  if (!basis || basis.promotion !== 0n) return null;
  const lines = BigInt(order.items.filter(item => validMoney(item.unitPrice) && item.unitPrice.amountMinor > 0).length);
  return { units, stated, moneyless: { prices: moneylessPrices, units: moneylessUnits, subtotal: basis.subtotal, tax: basis.tax, lines } };
}

/**
 * Refund money beyond what resolved item records account for: their stated money, and for records without money,
 * their units' prices plus their share of the order's tax (as `searchUnits` gives it), so a refund of exactly those
 * units leaves nothing over, within the same rounding margin. Never negative.
 */
function recordsRemainder(refund: bigint, resolved: ResolvedRecords): bigint {
  const left = refund - resolved.stated;
  if (!resolved.moneyless) return left > 0n ? left : 0n;
  const { prices, units, subtotal, tax, lines } = resolved.moneyless;
  const over = left * subtotal - prices * (subtotal + tax);
  if (tax === 0n ? over === 0n : abs(2n * over) <= (units + lines) * subtotal) return 0n;
  return over > 0n ? over / subtotal : 0n;
}

const sumUnits = (sets: ReadonlyArray<readonly RefundUnits[]>, quantities: ReadonlyMap<number, number>): RefundUnits[] | null => {
  const units = new Map<number, number>();
  for (const set of sets) for (const line of set) units.set(line.lineOrdinal, (units.get(line.lineOrdinal) ?? 0) + line.units);
  if ([...units].some(([ordinal, count]) => count > (quantities.get(ordinal) ?? 0))) return null;
  return [...units].map(([lineOrdinal, count]) => ({ lineOrdinal, units: count })).sort(byOrdinal);
};
const sameUnits = (a: readonly RefundUnits[], b: readonly RefundUnits[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An order's refunds: what is counted, and which of its items they are tied to. The counted amount is the largest of
 * its evidence (never their sum, so the same refund seen as a Refund Total, a ledger row and an item record counts
 * once). It is tied to items by the first rule that proves which, in this order: whole order; Amazon's item records,
 * when every one resolves to its own lines; units, for all of it (as one amount, matched as every refund together only
 * when it is Amazon's Refund Total and else under a payment's stricter scope, or as each ledger refund on its own,
 * which must agree); the only line; else, ledger refunds that each match units on their own, the rest not tied to
 * items. Ledger refunds that together name more units than were ordered contradict each other, and then no amount
 * ties units. Whatever no rule ties to items is "not attributed", with the reason the whole amount was held.
 */
export function attributeOrderRefunds(order: OrderObservation, evidence: OrderRefundEvidence): OrderRefundAttribution {
  const excluded = new Map<string, { source: RefundSource; reason: RefundExclusionReason; count: number }>();
  const exclude = (source: RefundSource, reason: RefundExclusionReason, count: number) => {
    if (count <= 0) return;
    const key = `${source}:${reason}`;
    excluded.set(key, { source, reason, count: (excluded.get(key)?.count ?? 0) + count });
  };
  const total = grandTotal(order);
  const lineCurrencies = new Set(order.items.flatMap(item => (validMoney(item.unitPrice) ? [item.unitPrice.currency] : [])));
  const summary = orderRefundTotal(evidence.summaries);
  const ledger = evidence.ledger.filter(money => {
    if (validMoney(money) && money.amountMinor !== 0) return true;
    exclude('ledger', 'invalid', 1);
    return false;
  });
  const records = (evidence.itemRecords ?? []).filter(record => {
    if (record.money === null || (validMoney(record.money) && record.money.amountMinor > 0)) return true;
    exclude('item-records', 'invalid', 1);
    return false;
  });
  // The order's currency, else the one its items are priced in, else the first the evidence states.
  const stated = summary?.kind === 'total' ? summary.money.currency
    : ledger[0]?.currency ?? records.find(record => record.money)?.money?.currency ?? null;
  const currency = total?.currency ?? (lineCurrencies.size === 1 ? [...lineCurrencies][0] : stated);
  const bounded = (source: RefundSource, amount: bigint, count: number): bigint => {
    if (total && amount > BigInt(total.amountMinor)) { exclude(source, 'exceeds-order-total', count); return 0n; }
    return amount;
  };

  let summaryMinor = 0n;
  if (summary && summary.kind !== 'total') exclude('order-summary', summary.kind, 1);
  else if (summary && summary.money.amountMinor > 0) {
    if (summary.money.currency !== currency) exclude('order-summary', 'currency-mismatch', 1);
    else summaryMinor = bounded('order-summary', BigInt(summary.money.amountMinor), 1);
  }
  let events = ledger.filter(money => {
    if (money.currency === currency) return true;
    exclude('ledger', 'currency-mismatch', 1);
    return false;
  }).map(money => ({ currency: money.currency, amountMinor: Math.abs(money.amountMinor) }));
  const ledgerMinor = bounded('ledger', events.reduce((sum, money) => sum + BigInt(money.amountMinor), 0n), events.length);
  if (ledgerMinor === 0n) events = [];
  let itemRecords = records.filter(record => {
    if (!record.money || record.money.currency === currency) return true;
    exclude('item-records', 'currency-mismatch', 1);
    return false;
  });
  // Item records count only as one resolved set. Rejected ones are left out altogether, their money included, so they
  // never prove an amount; and since they name the items Amazon refunded, no amount may then tie any other item.
  let resolved: ResolvedRecords | null = null, named: Set<number> | null = null;
  if (itemRecords.length && currency !== null) {
    const outcome = resolveRecords(order, itemRecords, currency);
    if (outcome === 'conflict' || outcome === null) {
      exclude('item-records', outcome === 'conflict' ? 'contradictory' : 'unresolved', itemRecords.length);
      named = new Set(itemRecords.flatMap(record => record.lines.map(line => line.lineOrdinal)));
      itemRecords = [];
    } else resolved = outcome;
  }
  const statedMinor = itemRecords.reduce((sum, record) => sum + BigInt(record.money?.amountMinor ?? 0), 0n);
  const recordsMinor = bounded('item-records', statedMinor, itemRecords.length);
  if (recordsMinor !== statedMinor) { itemRecords = []; resolved = null; }

  const refund = [summaryMinor, ledgerMinor, recordsMinor].reduce((a, b) => (b > a ? b : a), 0n);
  const answer: OrderRefundAttribution = { currency, refundMinor: Number(refund), source: null, basis: null, lines: [],
    unattributedMinor: 0, unattributedReason: null, excluded: [] };
  const done = () => {
    answer.excluded = [...excluded.values()].sort((a, b) => (`${a.source}:${a.reason}` < `${b.source}:${b.reason}` ? -1 : 1));
    return answer;
  };
  if (refund === 0n || currency === null) return done();
  answer.source = refund === summaryMinor ? 'order-summary' : refund === ledgerMinor ? 'ledger' : 'item-records';
  const attributed = (basis: RefundBasis, units: readonly RefundUnits[], unattributed = 0n, reason: UnattributedReason | null = null) => {
    // Amazon's rejected item records named the items it refunded: an amount may not tie any other.
    if (named && units.some(line => !named!.has(line.lineOrdinal)) && basis !== 'whole-order') {
      basis = 'unattributed'; units = []; unattributed = refund; reason = 'conflict';
    }
    answer.basis = basis;
    answer.lines = units.map(line => ({ ...line, moneyMinor: 0 }));
    answer.unattributedMinor = Number(unattributed);
    answer.unattributedReason = unattributed > 0n ? reason : null;
    return done();
  };
  const amount: Money = { currency, amountMinor: Number(refund) };
  // Only Amazon's Refund Total is every refund of the order together; ledger refunds or item records may be one
  // tender's share of a split payment, so their amount keeps the stricter scope of a payment.
  const whole = matchRefund(order, amount, answer.source === 'order-summary' ? 'order-total' : 'payment');
  if (whole.kind === 'whole-order') return attributed('whole-order', whole.lines);

  if (resolved && itemRecords.length) {
    const left = recordsRemainder(refund, resolved);
    return attributed(left > 0n ? 'partly' : 'item-records', [...resolved.units]
      .map(([lineOrdinal, units]) => ({ lineOrdinal, units })).sort(byOrdinal), left, 'no-match');
  }

  const quantities = new Map(order.items.filter(item => isOrdinal(item.lineOrdinal) && isQuantity(item.quantity))
    .map(item => [item.lineOrdinal!, item.quantity!]));
  const matched = events.map(event => ({ event, match: matchRefund(order, event, 'payment') }))
    .filter((entry): entry is { event: Money; match: Extract<RefundMatch, { kind: 'units' }> } => entry.match.kind === 'units');
  const union = matched.length ? sumUnits(matched.map(entry => entry.match.lines), quantities) : null;
  // Ledger refunds that each match units but together name more units than were ordered contradict each other: no
  // amount, the total included, may then tie units, whatever it matches.
  const overQuantity = matched.length > 0 && union === null;
  // Every ledger refund matching units on its own, and between them all of the counted amount.
  const perRefund = !overQuantity && events.length && ledgerMinor === refund && matched.length === events.length ? union : null;
  const conflict = overQuantity || (whole.kind === 'units' && perRefund !== null && !sameUnits(perRefund, whole.lines));
  if (whole.kind === 'units' && !conflict) return attributed('units', whole.lines);
  if (perRefund && !conflict) return attributed('units', perRefund);
  const only = order.items.length === 1 && itemBlockReconciles(order) ? order.items[0] : null;
  if (only && (whole.kind === 'only-line' || conflict) && (!named || named.has(only.lineOrdinal!))) {
    const price = BigInt(only.unitPrice!.amountMinor) * BigInt(only.quantity!);
    answer.basis = 'only-line';
    answer.lines = [{ lineOrdinal: only.lineOrdinal!, units: 0, moneyMinor: Number(refund < price ? refund : price) }];
    return done();
  }
  if (conflict) return attributed('unattributed', [], refund, 'conflict');
  const reason: UnattributedReason = whole.kind === 'held' ? whole.reason : 'conflict';
  if (union) {
    const tied = matched.reduce((sum, entry) => sum + BigInt(entry.event.amountMinor), 0n);
    return attributed('partly', union, refund - tied, reason);
  }
  return attributed('unattributed', [], refund, reason);
}
