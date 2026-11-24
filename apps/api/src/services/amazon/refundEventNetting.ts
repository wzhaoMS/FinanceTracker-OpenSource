import { itemBlockReconciles } from './allocation.js';
import { currency as isCurrency, minor } from './policy.js';
import {
  REFUND_SEARCH_LIMIT, pricedLines, searchUnits, taxBasis,
  type OrderRefundAttribution, type RefundBasis, type RefundExclusionReason, type RefundHoldReason, type RefundScope,
  type RefundSource, type RefundUnits, type UnattributedReason,
} from './refundAttribution.js';
import type { Money, OrderObservation, RefundEvidencePhrase } from './types.js';

/**
 * Amazon's own refund statements on its order-details pages (D) and its Returns page (R) in an order's net, next to
 * what refund attribution v1 (refundAttribution.ts) counts from its Refund Total (S) and payments-ledger refunds (L).
 * Pure: no database, clock or network.
 *
 * - **Identity first:** every statement, issued or not, names its items as its own capture shows them: by ASIN, else
 *   by exact title (a position is never identity), and maps to the one line of the order with that ASIN (else that
 *   title). None, or more than one, holds the order. Only then are statements grouped: one refund per source and
 *   stable line set, or, naming no item, per source and #155 projection event.
 * - **Progression, per refund in import order:** a statement counts only when it says the refund was issued
 *   (REFUND_ISSUED_PHRASES). A completed amount never goes down: a later smaller one holds the order as
 *   contradictory. A later pending statement never takes a completed amount back: the furthest completed amount stays
 *   counted and the step back is surfaced (`refund-status-regressed`). Pending then completed advances.
 * - **Once:** per line, the largest amount any refund proves for that line alone, whatever its source or identity,
 *   never their sum. A refund naming several lines proves each line's amount when its units are known and its money
 *   is exactly their prices plus their tax share; otherwise it is a bundle, worth the larger of its money and its
 *   lines' own amounts (overlapping bundles: the best set of them that shares no line). Refunds naming no item of one
 *   source add up only when they were seen together in one capture (distinct statements), else the largest counts;
 *   across sources the largest. The order's refund is the largest of what v1 counts, the itemized amount and the
 *   order-level amount: each is a lower bound of what Amazon refunded, so the largest never counts a refund twice.
 * - **Caps, per statement before anything is combined:** each issued statement is held to exactly the units it names:
 *   their prices plus their proportional share of the order's tax and shipping when both are known (within v1's
 *   rounding margin), else their prices; one naming no item, to the order's total, like the composed amount. More,
 *   more units than a line has, another currency, an item that maps to no single line, or a contradiction hold the
 *   order whole: none of its statements count (they are left out, counted) and whatever v1 counted stays whole, tied
 *   to no item (`conflict`). Nothing is netted in part and nothing is guessed.
 * - **Exact:** a refund's cents come off the items it names up to their prices, split between lines by integer
 *   largest remainder (ties to the lower line); cents beyond their prices are their tax and shipping. Inside a bundle,
 *   each line first keeps the item cents of the amount proved for it alone, and only the bundle's money beyond those
 *   amounts comes off its lines, first those no statement proves an amount for, within what each line's price leaves:
 *   only money beyond every named price is tax and shipping. What v1 counts beyond the statements goes first to lines
 *   named without an amount, then by v1's own rules over the units left, else stays tied to no item. So the order's
 *   refund is exactly its item cents, tax and shipping cents and unattributed cents.
 *
 * Without an issued statement, an order's refund is v1's own, unchanged.
 */
export const REFUND_EVENT_NETTING_POLICY = Object.freeze({
  version: 'amazon-refund-event-netting-v1',
  identity: 'asin-else-exact-title-in-the-statements-own-capture-never-position-before-grouping',
  refund: 'per-source-stable-line-set-or-projection-event-when-no-item',
  progression: 'completed-nondecreasing-else-contradictory-step-back-keeps-furthest-and-is-surfaced',
  counted: 'issued-statements-only',
  perLine: 'largest-across-sources-and-identities-never-summed',
  granularity: 'per-line-when-units-and-tax-prove-it-else-bundle',
  bundles: 'proven-line-item-cents-first-excess-off-price-room-unproven-lines-first-over-disjoint-bundle-sets',
  unitemized: 'seen-together-in-one-capture-summed-else-largest-across-sources-largest',
  orderRefund: 'largest-of-attribution-v1-itemized-and-unitemized-never-summed',
  caps: 'each-statement-named-units-prices-plus-proportional-tax-shipping-when-known-else-prices-order-total-unitemized',
  deduction: 'cents-up-to-named-units-prices-largest-remainder-rest-tax-shipping',
  remainder: 'lines-named-without-amount-then-refund-attribution-v1-over-units-left',
  hold: 'whole-order-not-attributed-statements-left-out',
});
/** Statements that say a refund was issued. `Refund for this return` with an amount alone, or a pending one, never do. */
export const REFUND_ISSUED_PHRASES: readonly RefundEvidencePhrase[] = Object.freeze(['refund-issued', 'refund-complete',
  'refund-processed', 'refunded']);
/** Why an order's page refund statements held its refund attribution whole: the first rule that held. */
export const REFUND_EVENT_HOLD_REASONS = ['order-total-missing', 'currency-mismatch', 'contradictory', 'item-unmapped',
  'exceeds-order-total', 'exceeds-item-charge'] as const;
export type RefundEventHoldReason = (typeof REFUND_EVENT_HOLD_REASONS)[number];
/** What an order's page refund statements showed that holds nothing but is surfaced: a refund's status stepping back. */
export const REFUND_EVENT_CONFLICT_REASONS = ['refund-status-regressed'] as const;
export type RefundEventConflictReason = (typeof REFUND_EVENT_CONFLICT_REASONS)[number];
/** How a held order's statements count among refund records left out. */
const LEFT_OUT: Readonly<Record<RefundEventHoldReason, RefundExclusionReason>> = Object.freeze({
  'order-total-missing': 'unresolved', 'currency-mismatch': 'currency-mismatch', contradictory: 'contradictory',
  'item-unmapped': 'unresolved', 'exceeds-order-total': 'exceeds-order-total', 'exceeds-item-charge': 'contradictory',
});

export type PageRefundSource = 'order-details' | 'returns-page';
/** One item a page refund statement names, as the statement's own capture shows it. */
export interface PageRefundItem {
  /** Never identity: a position is capture-scoped. Kept for the shape only. */
  lineOrdinal: number | null;
  /** Its ASIN, when shown. */
  itemId: string | null;
  /** Its exact title, when shown: the Returns page's, or its capture's own line's. */
  title: string | null;
  /** Units refunded, only when the page stated them. */
  units: number | null;
}
/** One page refund statement (or, without `capture`, one refund taken as it is). */
export interface PageRefundEvent {
  source: PageRefundSource;
  /** The amount it states when it says the refund was issued; null when it states none. */
  money: Money | null;
  /** It contradicts itself (a caller's own finding). */
  contradictory: boolean;
  /** None: a refund of the order that its page did not tie to items. */
  items: PageRefundItem[];
  /** Statements it stands for. */
  observations: number;
  /** Whether it says the refund was issued (default); a pending or expected refund doesn't. */
  issued?: boolean;
  /** The import order of the capture that read it. Without it, no order in time and no capture in common. */
  capture?: number;
  /** Its #155 projection event: the same statement across captures. */
  event?: string;
}
/**
 * One part of a composed refund: money, the item cents it took off its lines (split exactly between them), and the
 * rest, which is tax and shipping, or not attributed to items (`unattributed`).
 */
export interface RefundPart {
  kind: 'whole-order' | 'line' | 'bundle' | 'named' | 'units' | 'only-line' | 'unattributed';
  lines: number[];
  moneyMinor: number;
  itemMinor: number;
  allocation: Array<{ lineOrdinal: number; minor: number }>;
}
export interface OrderRefundComposition {
  attribution: OrderRefundAttribution;
  /** The order's issued page refunds as their projection names them (event and item identity), and their statements. */
  events: number;
  observations: number;
  /** Why they held the order's refund attribution whole; null when they didn't. */
  held: RefundEventHoldReason | null;
  /** How the composed refund came apart, exactly; empty when it is v1's own or held. */
  parts: RefundPart[];
  /** What they showed that holds nothing but is surfaced. */
  conflicts: RefundEventConflictReason[];
}

interface Line { quantity: number; unit: bigint }
interface Named { lineOrdinal: number; units: number | null }
interface Charge { subtotal: bigint; tax: bigint; shipping: bigint; promotion: bigint; priced: bigint }
interface Bundle { lines: number[]; money: bigint; named: Named[] }
interface Mapped { statement: PageRefundEvent; index: number; issued: boolean; named: Named[]; money: bigint | null }
/** One refund after progression: its source, lines (none: the order's), furthest completed money, and captures seen in. */
interface Refund { source: PageRefundSource; named: Named[]; money: bigint | null; captures: number[] }

const validMoney = (money: Money | null | undefined): money is Money => !!money && isCurrency(money.currency) && minor(money.amountMinor);
const isOrdinal = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 99;
const isQuantity = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const smaller = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const sumOf = (values: readonly bigint[]): bigint => values.reduce((sum, value) => sum + value, 0n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const byOrdinal = (a: { lineOrdinal: number }, b: { lineOrdinal: number }) => a.lineOrdinal - b.lineOrdinal;
const identityOf = (items: readonly PageRefundItem[]) => items.map(item => (item.itemId !== null ? `asin:${item.itemId}`
  : item.title !== null ? `title:${item.title}` : 'unknown')).sort();

/** The order's lines a refund can be for: one ordinal each, a quantity, and a price in the order's currency. */
function chargedLines(order: OrderObservation, currency: string): Map<number, Line> {
  const seen = new Map<unknown, number>();
  for (const item of order.items) seen.set(item.lineOrdinal, (seen.get(item.lineOrdinal) ?? 0) + 1);
  const lines = new Map<number, Line>();
  for (const item of order.items) {
    if (!isOrdinal(item.lineOrdinal) || seen.get(item.lineOrdinal) !== 1 || !isQuantity(item.quantity)
      || !validMoney(item.unitPrice) || item.unitPrice.amountMinor < 0 || item.unitPrice.currency !== currency) continue;
    lines.set(item.lineOrdinal, { quantity: item.quantity, unit: BigInt(item.unitPrice.amountMinor) });
  }
  return lines;
}

/** The order's item subtotal, tax, shipping and promotion when each is known (listed once, in its currency). */
function chargeBasis(order: OrderObservation, currency: string): Charge | null {
  const basis = taxBasis(order, currency);
  const shipping = (order.summary ?? []).filter(entry => entry.kind === 'shipping');
  if (!basis || shipping.length !== 1 || !validMoney(shipping[0].money) || shipping[0].money.currency !== currency
    || shipping[0].money.amountMinor < 0) return null;
  const priced = order.items.filter(item => validMoney(item.unitPrice) && item.unitPrice.amountMinor > 0).length;
  return { ...basis, shipping: BigInt(shipping[0].money.amountMinor), priced: BigInt(priced) };
}

/**
 * The one line of the order a statement's item is: by its ASIN; when no line shows that ASIN, by its exact title on
 * a line showing no ASIN; without an ASIN, by its exact title. None, or more than one, is null.
 */
function lineOf(order: OrderObservation, item: PageRefundItem): number | null {
  const one = (found: OrderObservation['items']) => (found.length === 1 && isOrdinal(found[0].lineOrdinal) ? found[0].lineOrdinal : null);
  if (item.itemId !== null) {
    const byAsin = order.items.filter(line => line.itemId === item.itemId);
    if (byAsin.length) return one(byAsin);
    return item.title !== null ? one(order.items.filter(line => line.itemId === null && line.title === item.title)) : null;
  }
  return item.title !== null ? one(order.items.filter(line => line.title === item.title)) : null;
}

/** Integer shares of `total` by weight that add up to it exactly: the remainder to the largest fractions, ties to the lower line. */
function allocate(total: bigint, weights: ReadonlyArray<{ lineOrdinal: number; weight: bigint }>): Map<number, bigint> {
  const denominator = sumOf(weights.map(w => w.weight));
  if (denominator === 0n) return new Map(weights.map(w => [w.lineOrdinal, 0n]));
  const parts = weights.map(w => ({ lineOrdinal: w.lineOrdinal, share: total * w.weight / denominator,
    remainder: total * w.weight % denominator }));
  let left = total - sumOf(parts.map(p => p.share));
  parts.sort((a, b) => (a.remainder === b.remainder ? a.lineOrdinal - b.lineOrdinal : a.remainder > b.remainder ? -1 : 1));
  for (const part of parts) if (left > 0n) { part.share++; left--; }
  return new Map(parts.map(p => [p.lineOrdinal, p.share]));
}

/**
 * The most a statement may state for exactly the units it names (all of a line's when it states none): their prices,
 * plus their proportional share of the order's tax and shipping when both are known, within v1's rounding margin of
 * half a cent per unit and per priced line.
 */
function namedCap(named: readonly Named[], lines: ReadonlyMap<number, Line>, charge: Charge | null): bigint {
  let prices = 0n, units = 0n;
  for (const entry of named) {
    const line = lines.get(entry.lineOrdinal)!;
    const count = BigInt(entry.units ?? line.quantity);
    prices += count * line.unit;
    units += count;
  }
  if (!charge || charge.tax + charge.shipping === 0n) return prices;
  return prices + ceilDiv(prices * (charge.tax + charge.shipping), charge.subtotal) + ceilDiv(units + charge.priced, 2n);
}

/** Whether `money` is the prices of units costing `prices` plus their share of `extra` (v1's margin; exact when none). */
function charged(money: bigint, prices: bigint, units: bigint, extra: bigint, charge: Charge): boolean {
  if (extra === 0n) return money === prices;
  return abs(2n * (money * charge.subtotal - prices * (charge.subtotal + extra))) <= (units + charge.priced) * charge.subtotal;
}

/**
 * The per-line amounts a refund naming several lines proves: every line's units known (stated, or a line's only
 * unit), the order's tax and shipping known with no promotion, and its money exactly those units' prices plus their
 * tax share (or tax and shipping share). Then its money splits by their prices; otherwise null, a bundle.
 */
function splitBundle(refund: Refund, lines: ReadonlyMap<number, Line>, charge: Charge | null):
  Array<{ lineOrdinal: number; units: number; money: bigint }> | null {
  if (refund.money === null || !charge || charge.promotion !== 0n) return null;
  const stated = refund.named.map(entry => entry.units ?? (lines.get(entry.lineOrdinal)!.quantity === 1 ? 1 : null));
  if (stated.some(count => count === null)) return null;
  const units = stated as number[];
  const values = refund.named.map((entry, i) => BigInt(units[i]) * lines.get(entry.lineOrdinal)!.unit);
  const prices = sumOf(values), count = BigInt(units.reduce((n, u) => n + u, 0));
  if (prices === 0n || (!charged(refund.money, prices, count, charge.tax, charge)
    && !charged(refund.money, prices, count, charge.tax + charge.shipping, charge))) return null;
  const shares = allocate(refund.money, refund.named.map((entry, i) => ({ lineOrdinal: entry.lineOrdinal, weight: values[i] })));
  return refund.named.map((entry, i) => ({ lineOrdinal: entry.lineOrdinal, units: units[i], money: shares.get(entry.lineOrdinal)! }));
}

/**
 * Of overlapping bundles, the set sharing no line whose money beyond their lines' own amounts is largest. Ties keep
 * the lines' own amounts (the finest proof), then the first set in canonical order; a search past
 * REFUND_SEARCH_LIMIT keeps the best found, still a lower bound.
 */
function bestPacking(bundles: readonly Bundle[], excess: (bundle: Bundle) => bigint): Bundle[] {
  let best = { chosen: [] as Bundle[], value: 0n };
  let visits = 0;
  const chosen: Bundle[] = [];
  const covered = new Set<number>();
  const walk = (i: number, sum: bigint): void => {
    if (++visits > REFUND_SEARCH_LIMIT) return;
    if (i === bundles.length) {
      if (sum > best.value) best = { chosen: [...chosen], value: sum };
      return;
    }
    walk(i + 1, sum);
    const bundle = bundles[i];
    if (excess(bundle) === 0n || bundle.lines.some(line => covered.has(line))) return;
    chosen.push(bundle);
    for (const line of bundle.lines) covered.add(line);
    walk(i + 1, sum + excess(bundle));
    for (const line of bundle.lines) covered.delete(line);
    chosen.pop();
  };
  walk(0, 0n);
  return best.chosen;
}

/**
 * What refund attribution v1 ties `amount` to, over the units nothing took cents off yet (a line partly refunded
 * keeps only its untouched units): v1's own checks in v1's order, from the item list's proof on, since the whole
 * order was ruled out.
 */
type Residual = { kind: 'units'; lines: RefundUnits[] } | { kind: 'only-line'; lineOrdinal: number } | { kind: 'held'; reason: RefundHoldReason };
function matchResidual(order: OrderObservation, amount: bigint, currency: string, deducted: ReadonlyMap<number, bigint>,
  scope: RefundScope): Residual {
  const held = (reason: RefundHoldReason): Residual => ({ kind: 'held', reason });
  if (!itemBlockReconciles(order)) return held('items-unproven');
  if (order.items.some(item => item.unitPrice!.currency !== currency)) return held('currency-mismatch');
  const only = order.items.length === 1 ? order.items[0].lineOrdinal! : null;
  const otherwise = (reason: RefundHoldReason): Residual => (only === null ? held(reason) : { kind: 'only-line', lineOrdinal: only });
  const basis = taxBasis(order, currency);
  if (!basis) return otherwise('summary-incomplete');
  if (basis.promotion !== 0n) return otherwise('promotion');
  if (scope === 'payment' && order.tenderCoverage !== 'single-card-proven') return otherwise('mixed-tender');
  const all = pricedLines(order);
  const left = all.flatMap(line => {
    const taken = deducted.get(line.lineOrdinal) ?? 0n;
    const touched = taken === 0n ? 0n : line.price === 0n ? BigInt(line.quantity) : ceilDiv(taken, line.price);
    const quantity = line.quantity - Number(touched);
    return quantity > 0 ? [{ ...line, quantity }] : [];
  });
  const found = searchUnits(left, basis.subtotal, basis.tax, amount, all.filter(line => line.price > 0n).length);
  if (found.kind === 'unique') return { kind: 'units', lines: found.units };
  return otherwise(found.kind === 'none' ? 'no-match' : found.kind === 'ambiguous' ? 'ambiguous' : 'search-limit');
}

/** v1's answer with the order's statements left out under `reason`'s exclusion, and any counted refund tied to no item. */
function holdWhole(base: OrderRefundAttribution, reason: RefundEventHoldReason, events: number): OrderRefundAttribution {
  const excluded = new Map(base.excluded.map(entry => [`${entry.source}:${entry.reason}`, { ...entry }]));
  const key = `item-records:${LEFT_OUT[reason]}`;
  excluded.set(key, { source: 'item-records', reason: LEFT_OUT[reason], count: (excluded.get(key)?.count ?? 0) + events });
  const left = [...excluded.values()].sort((a, b) => (`${a.source}:${a.reason}` < `${b.source}:${b.reason}` ? -1 : 1));
  if (base.refundMinor === 0 || base.basis === null) return { ...base, excluded: left };
  return { ...base, basis: 'unattributed', lines: [], unattributedMinor: base.refundMinor, unattributedReason: 'conflict', excluded: left };
}

/** Larger money first, then stated units (more of them first): the statement whose amount and units a refund keeps. */
function preferred(a: Mapped, b: Mapped): number {
  if (a.money !== b.money) return a.money === null ? 1 : b.money === null ? -1 : a.money > b.money ? -1 : 1;
  const ua = JSON.stringify(a.named.map(entry => entry.units ?? -1)), ub = JSON.stringify(b.named.map(entry => entry.units ?? -1));
  return ua === ub ? 0 : ua > ub ? -1 : 1;
}

/**
 * An order's refunds with its page refund statements (see the module's rules), from v1's answer for its Refund Total
 * and ledger refunds (`base`, attributeOrderRefunds). Without an issued statement, `base` itself.
 */
export function composeOrderRefunds(order: OrderObservation, base: OrderRefundAttribution,
  statements: readonly PageRefundEvent[]): OrderRefundComposition {
  // A refund as its projection names it, for the counts: one #155 event's statements about one item identity.
  const entries = statements.map((statement, index) => ({ statement, index, issued: statement.issued !== false,
    group: statement.event !== undefined ? JSON.stringify([statement.event, identityOf(statement.items)]) : `solo:${index}` }));
  const issuedGroups = new Set(entries.filter(entry => entry.issued).map(entry => entry.group));
  if (!issuedGroups.size) return { attribution: base, events: 0, observations: 0, held: null, parts: [], conflicts: [] };
  const events = issuedGroups.size;
  const observations = entries.filter(entry => issuedGroups.has(entry.group)).reduce((n, entry) => n + entry.statement.observations, 0);
  const done = (attribution: OrderRefundAttribution, held: RefundEventHoldReason | null = null, parts: RefundPart[] = [],
    conflicts: RefundEventConflictReason[] = []): OrderRefundComposition => ({ attribution, events, observations, held, parts, conflicts });
  const hold = (reason: RefundEventHoldReason) => done(holdWhole(base, reason, events), reason);

  const total = validMoney(order.total) && order.total.amountMinor > 0 ? order.total : null;
  if (!total) return hold('order-total-missing');
  const currency = total.currency, orderTotal = BigInt(total.amountMinor);
  const issuedStatements = entries.filter(entry => entry.issued).map(entry => entry.statement);
  if (issuedStatements.some(statement => validMoney(statement.money) && statement.money.currency !== currency)) return hold('currency-mismatch');
  if (issuedStatements.some(statement => statement.contradictory
    || (statement.money !== null && (!validMoney(statement.money) || statement.money.amountMinor <= 0)))) return hold('contradictory');
  const lines = chargedLines(order, currency);
  // Every statement, issued or not, to the order's lines by identity: a pending one is part of its line's history.
  const mapped: Mapped[] = [];
  for (const entry of entries) {
    const named = entry.statement.items.map(item => ({ lineOrdinal: lineOf(order, item), units: item.units }));
    if (named.some(item => item.lineOrdinal === null || !lines.has(item.lineOrdinal))
      || new Set(named.map(item => item.lineOrdinal)).size !== named.length) return hold('item-unmapped');
    mapped.push({ statement: entry.statement, index: entry.index, issued: entry.issued, named: (named as Named[]).sort(byOrdinal),
      money: entry.issued && entry.statement.money ? BigInt(entry.statement.money.amountMinor) : null });
  }
  if (mapped.some(m => m.money !== null && m.money > orderTotal)) return hold('exceeds-order-total');
  // Each issued statement is held to exactly the units it names, before any other statement can widen its scope.
  const charge = chargeBasis(order, currency);
  for (const m of mapped.filter(entry => entry.issued)) {
    if (m.named.some(entry => entry.units !== null && entry.units > lines.get(entry.lineOrdinal)!.quantity)
      || (m.money !== null && m.named.length && m.money > namedCap(m.named, lines, charge))) return hold('exceeds-item-charge');
  }

  // One refund per source and stable line set, or per source and projection event naming no item; its history in
  // import order: a completed amount never goes down, a later pending statement never takes it back.
  const histories = new Map<string, { source: PageRefundSource; statements: Mapped[] }>();
  for (const m of mapped) {
    const key = m.named.length ? JSON.stringify([m.statement.source, m.named.map(entry => entry.lineOrdinal)])
      : m.statement.event !== undefined ? JSON.stringify([m.statement.source, 'order', m.statement.event]) : `solo:${m.index}`;
    const history = histories.get(key) ?? { source: m.statement.source, statements: [] };
    history.statements.push(m);
    histories.set(key, history);
  }
  let regressed = false;
  const refunds: Refund[] = [];
  for (const [, history] of [...histories].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const completed = history.statements.filter(m => m.issued);
    if (!completed.length) continue;
    const captures = [...new Set(history.statements.flatMap(m => (m.statement.capture === undefined ? [] : [m.statement.capture])))]
      .sort((a, b) => a - b);
    let furthest: bigint | null = null, issued = false;
    for (const capture of captures) {
      const here = history.statements.filter(m => m.statement.capture === capture);
      const done = here.filter(m => m.issued);
      if (!done.length) {
        if (issued) regressed = true;
        continue;
      }
      issued = true;
      const amounts = done.flatMap(m => (m.money === null ? [] : [m.money]));
      if (!amounts.length) continue;
      const amount = amounts.reduce(larger);
      if (furthest !== null && amount < furthest) return hold('contradictory');
      furthest = furthest === null ? amount : larger(furthest, amount);
    }
    const kept = [...completed].sort(preferred)[0];
    refunds.push({ source: history.source, named: kept.named, money: kept.money, captures });
  }

  // Per line, the largest amount proved for that line alone; bundles where no split is proven.
  const own = new Map<number, { money: bigint; units: number | null }>();
  const rank = (units: number | null) => (units === null ? -1 : units);
  const prove = (line: number, money: bigint, units: number | null) => {
    const prior = own.get(line);
    if (!prior || money > prior.money || (money === prior.money && rank(units) > rank(prior.units))) own.set(line, { money, units });
  };
  const bundles: Bundle[] = [];
  for (const refund of refunds) {
    if (refund.money === null || !refund.named.length) continue;
    if (refund.named.length === 1) { prove(refund.named[0].lineOrdinal, refund.money, refund.named[0].units); continue; }
    const split = splitBundle(refund, lines, charge);
    if (split) for (const part of split) prove(part.lineOrdinal, part.money, part.units);
    else bundles.push({ lines: refund.named.map(entry => entry.lineOrdinal), money: refund.money, named: refund.named });
  }
  const bundleKey = (bundle: Bundle) => JSON.stringify([bundle.lines, bundle.named.map(entry => entry.units)]);
  bundles.sort((a, b) => {
    const ka = bundleKey(a), kb = bundleKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.money === b.money ? 0 : a.money > b.money ? -1 : 1;
  });
  // Bundles sharing a line are one component: its lines' own amounts, plus the best set of its bundles sharing no
  // line, each adding only its money beyond its lines' own amounts.
  const parent = new Map<number, number>();
  const root = (line: number): number => { let at = line; while (parent.get(at) !== at) at = parent.get(at)!; return at; };
  for (const bundle of bundles) for (const line of bundle.lines) if (!parent.has(line)) parent.set(line, line);
  for (const bundle of bundles) {
    for (const line of bundle.lines) {
      const a = root(bundle.lines[0]), b = root(line);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  }
  const ownMoney = (line: number) => own.get(line)?.money ?? 0n;
  const excess = (bundle: Bundle) => larger(0n, bundle.money - sumOf(bundle.lines.map(ownMoney)));
  const components = new Map<number, Bundle[]>();
  for (const bundle of bundles) components.set(root(bundle.lines[0]), [...(components.get(root(bundle.lines[0])) ?? []), bundle]);
  const chosen: Bundle[] = [];
  for (const [, group] of [...components].sort(([a], [b]) => a - b)) chosen.push(...bestPacking(group, excess));
  const itemized = sumOf([...own.values()].map(entry => entry.money)) + sumOf(chosen.map(excess));
  // Refunds naming no item: of one source, those seen together in one capture are distinct statements and add up;
  // otherwise, and across sources, the largest.
  let unitemized = 0n;
  for (const source of ['order-details', 'returns-page'] as const) {
    const sums = new Map<number, bigint>();
    for (const refund of refunds.filter(r => r.source === source && !r.named.length && r.money !== null)) {
      unitemized = larger(unitemized, refund.money!);
      for (const capture of refund.captures) sums.set(capture, (sums.get(capture) ?? 0n) + refund.money!);
    }
    for (const sum of sums.values()) unitemized = larger(unitemized, sum);
  }
  const pageRefund = larger(itemized, unitemized);
  if (pageRefund > orderTotal) return hold('exceeds-order-total');
  const conflicts: RefundEventConflictReason[] = regressed ? ['refund-status-regressed'] : [];

  const counted = BigInt(base.refundMinor);
  const refund = larger(counted, pageRefund);
  const itemizedRefunds = refunds.some(entry => entry.named.length);
  // Refunds without money and nothing else counted; or order-level refunds within what v1 already counted.
  if (refund === 0n || (!itemizedRefunds && pageRefund <= counted)) return done(base, null, [], conflicts);
  const source: RefundSource = counted > 0n && counted >= pageRefund && base.source ? base.source : 'item-records';
  const answer: OrderRefundAttribution = { currency, refundMinor: Number(refund), source, basis: null, lines: [],
    unattributedMinor: 0, unattributedReason: null, excluded: base.excluded };
  const parts: RefundPart[] = [];
  const deducted = new Map<number, bigint>();
  const sum = (allocation: ReadonlyArray<{ minor: number }>) => allocation.reduce((n, a) => n + a.minor, 0);
  const record = (kind: RefundPart['kind'], money: bigint, cents: ReadonlyMap<number, bigint>) => {
    for (const [line, share] of cents) deducted.set(line, (deducted.get(line) ?? 0n) + share);
    const allocation = [...cents].sort(([a], [b]) => a - b).map(([lineOrdinal, share]) => ({ lineOrdinal, minor: Number(share) }));
    parts.push({ kind, lines: allocation.map(a => a.lineOrdinal), moneyMinor: Number(money), itemMinor: sum(allocation), allocation });
  };
  const take = (kind: RefundPart['kind'], money: bigint, itemMinor: bigint, weights: ReadonlyArray<{ lineOrdinal: number; weight: bigint }>) =>
    record(kind, money, allocate(itemMinor, weights));
  const price = (line: number, units: number | null) => BigInt(units ?? lines.get(line)!.quantity) * lines.get(line)!.unit;
  // Cents as whole units and the money of a partial unit, so the view takes exactly these cents off each line.
  const asLines = () => [...deducted].filter(([, cents]) => cents > 0n).sort(([a], [b]) => a - b).map(([lineOrdinal, cents]) => {
    const unit = lines.get(lineOrdinal)!.unit;
    const units = unit > 0n ? cents / unit : 0n;
    return { lineOrdinal, units: Number(units), moneyMinor: Number(cents - units * unit) };
  });

  if (refund === orderTotal) {
    // Every unit came back: each line's whole price, the rest tax and shipping (or, after a promotion, the refund
    // spread over the lines by their prices, since it is less than they cost).
    answer.basis = 'whole-order';
    const whole = [...lines].sort(([a], [b]) => a - b).map(([lineOrdinal, line]) => ({ lineOrdinal, weight: BigInt(line.quantity) * line.unit }));
    const prices = sumOf(whole.map(w => w.weight));
    take('whole-order', refund, smaller(refund, prices), whole);
    answer.lines = refund >= prices
      ? [...lines].sort(([a], [b]) => a - b).map(([lineOrdinal, line]) => ({ lineOrdinal, units: line.quantity, moneyMinor: 0 }))
      : asLines();
    return done(answer, null, parts, conflicts);
  }

  // A line's own amount comes off it up to the price of the units it proves (stated, its only unit, or the one count
  // v1's margin matches), else its whole price.
  const provenPrice = (line: number) => {
    const entry = own.get(line)!;
    let units = entry.units ?? (lines.get(line)!.quantity === 1 ? 1 : null);
    if (units === null && charge && charge.promotion === 0n && itemBlockReconciles(order)) {
      const found = searchUnits([{ lineOrdinal: line, quantity: lines.get(line)!.quantity, price: lines.get(line)!.unit }],
        charge.subtotal, charge.tax, entry.money, Number(charge.priced));
      if (found.kind === 'unique') units = found.units[0].units;
    }
    return price(line, units);
  };
  const inBundles = new Set(chosen.flatMap(bundle => bundle.lines));
  for (const [line, entry] of [...own].sort(([a], [b]) => a - b)) {
    if (inBundles.has(line)) continue;
    take('line', entry.money, smaller(entry.money, provenPrice(line)), [{ lineOrdinal: line, weight: 1n }]);
  }
  // Inside a chosen bundle each line first keeps the item cents of its own amount. The bundle's money beyond its lines'
  // own amounts then comes off what their prices leave, first on the lines no statement proves an amount for, by
  // integer largest remainder within each line's room. Only money beyond every named price is tax and shipping, so a
  // bundle at or below its prices takes off exactly its cents.
  for (const bundle of chosen) {
    const extra = excess(bundle);
    const room = bundle.named.map(entry => {
      const line = entry.lineOrdinal, kept = own.has(line) ? smaller(ownMoney(line), provenPrice(line)) : 0n;
      const ceiling = larger(price(line, entry.units), own.has(line) ? provenPrice(line) : 0n);
      return { lineOrdinal: line, kept, weight: ceiling - kept };
    });
    const items = smaller(extra, sumOf(room.map(entry => entry.weight)));
    const unproven = room.filter(entry => !own.has(entry.lineOrdinal)), proven = room.filter(entry => own.has(entry.lineOrdinal));
    const first = smaller(items, sumOf(unproven.map(entry => entry.weight)));
    const shares = new Map([...allocate(first, unproven), ...allocate(items - first, proven)]);
    record('bundle', sumOf(bundle.lines.map(ownMoney)) + extra,
      new Map(room.map(entry => [entry.lineOrdinal, entry.kept + (shares.get(entry.lineOrdinal) ?? 0n)])));
  }

  // What v1 counts beyond the statements' money: first the lines named without an amount (at least a unit each).
  let left = refund - itemized;
  const named = new Map<number, number>();
  for (const entry of refunds) {
    if (entry.money !== null) continue;
    for (const item of entry.named) {
      if ((deducted.get(item.lineOrdinal) ?? 0n) > 0n) continue;
      named.set(item.lineOrdinal, Math.max(named.get(item.lineOrdinal) ?? 0, item.units ?? 1));
    }
  }
  if (left > 0n && named.size) {
    const weights = [...named].sort(([a], [b]) => a - b).map(([lineOrdinal, units]) => ({ lineOrdinal, weight: price(lineOrdinal, units) }));
    const prices = sumOf(weights.map(w => w.weight));
    const value = charge && prices > 0n ? prices + ceilDiv(prices * charge.tax, charge.subtotal) : prices;
    const money = smaller(left, value);
    take('named', money, smaller(money, prices), weights);
    left -= money;
  }
  const pinned = parts.some(part => part.itemMinor > 0);
  let basis: RefundBasis = 'item-records', reason: UnattributedReason | null = null;
  if (left > 0n) {
    const match = matchResidual(order, left, currency, deducted, source === 'order-summary' ? 'order-total' : 'payment');
    if (match.kind === 'units') {
      const weights = match.lines.map(entry => ({ lineOrdinal: entry.lineOrdinal, weight: BigInt(entry.units) * lines.get(entry.lineOrdinal)!.unit }));
      take('units', left, smaller(left, sumOf(weights.map(w => w.weight))), weights);
      if (!pinned) basis = 'units';
    } else if (match.kind === 'only-line') {
      const room = BigInt(lines.get(match.lineOrdinal)!.quantity) * lines.get(match.lineOrdinal)!.unit - (deducted.get(match.lineOrdinal) ?? 0n);
      take('only-line', left, smaller(left, room > 0n ? room : 0n), [{ lineOrdinal: match.lineOrdinal, weight: 1n }]);
      if (!pinned) basis = 'only-line';
    } else {
      parts.push({ kind: 'unattributed', lines: [], moneyMinor: Number(left), itemMinor: 0, allocation: [] });
      answer.unattributedMinor = Number(left);
      basis = pinned ? 'partly' : 'unattributed';
      reason = match.reason;
    }
  }
  answer.basis = basis;
  answer.unattributedReason = reason;
  answer.lines = asLines();
  return done(answer, null, parts, conflicts);
}
