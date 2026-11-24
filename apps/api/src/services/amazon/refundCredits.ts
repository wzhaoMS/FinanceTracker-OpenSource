import type { Database } from 'better-sqlite3';
import { amazonCardChargeKind, lineAmount as sharedLineAmount, taxShare as sharedTaxShare } from '@finance-tracker/shared';
// STEP 9 integration (B5)
import { itemBlockReconciles, largestRemainder, ledgerOrderProof, lineTieKeys, observationScope, orderHistoryConflicts,
  selectOrderTotalSnapshot, type OrderSnapshot } from './allocation.js';
import { activeBindings, readCardInventory } from './bindings.js';
import { matchAmazon, readLedger, readSubjects } from './matcher.js';
import { day, digest, minor, opaque, ref } from './policy.js';
import { REFUND_ATTRIBUTION_POLICY_DIGEST, splitRefund } from './refundAttribution.js';
import { hasAmazonSchema } from './schema.js';
import { singleCardProven } from './tender.js';
import type { Allocation, Binding, EvidenceClass, LedgerRow, MatchResult, MatchSubject, Method, Money, OrderObservation } from './types.js';

/**
 * Amazon refund credits on the card statements (C-MATCHING-SPEC draft 1, on Root's proof decision): which order a
 * credit refunds, by exact-cents proof only, and the item parts of a credit that reverses charges Spending already
 * files under their items (a full refund mirrors them; a partial one is split by refundAttribution.ts's `splitRefund`).
 * Every function is pure except the two readers, which only read.
 *
 * A ledger `Refunded` row's link (the whole-ledger matcher's) is final. Any other in-scope credit links to an order
 * only when the order is its single competitor in the window, on the same card, and proven to the cent by the
 * order's refund total (R), its grand total (F) or the tax-inclusive price of a set of its units (S), within the
 * order's capacity. Who competes is Root's hybrid: when an order proves the credit by its refund total on its own
 * card, only orders proving it equally on that card compete; otherwise every order that could possibly explain the
 * amount does. Anything else is held, never guessed; a credit no order could explain has no candidate.
 */
export interface RefundCreditPolicy {
  /** Credit date minus order date, in calendar days, both bounds inclusive. */
  minLagDays: number;
  maxLagDays: number;
  /** Unit-subset search bounds: priced lines per order, and product(qty + 1) - 1 combinations. */
  maxLines: number;
  maxCombos: number;
  /**
   * `conservative`: every possible order in the window competes; `literal`: only proven same-card orders do;
   * `hybrid`: literal when a same-card order proves the credit by its refund total, conservative otherwise.
   */
  competitors: 'conservative' | 'literal' | 'hybrid';
}
export const REFUND_CREDIT_POLICY = Object.freeze({
  version: 'amazon-refund-credit-v1',
  spec: 'holdr.amazon-refund-order-proof.draft-1',
  minLagDays: 0,
  maxLagDays: 90,
  maxLines: 12,
  maxCombos: 4096,
  competitors: 'hybrid' as const,
  credits: 'live-posted-usd-negative-itemizable-amazon-descriptor-not-already-linked',
  proofs: 'ledger-refunded-final-else-refund-summary-full-order-or-tax-inclusive-unit-subset',
  tax: 'line-share-round-half-up-no-pretax-variant-proven-complete-summary-only',
  card: 'charge-or-destination-same-single-card-elsewhere-excluded-else-unknown',
  capacity: 'refund-summary-observed-after-every-claim-ledger-dates-included-else-total-line-quantities-ledger-units-consumed',
  contradictions: 'conflicting-order-history-or-shrinking-refund-total-competes-up-to-history-bound-never-proves',
  // STEP 9 integration (B5, Root): every refund-credit tie, and a credit's part order, by the history reader's line identity only
  itemization: 'full-card-paid-refund-negates-itemized-charge-item-margins-largest-remainder-credits-by-row-ties-and-part-order-by-history-line-identity-only-else-whole-v5',
  partialRefund: 'split-refund-payment-scope-on-the-charges-observation-ties-and-part-order-by-history-line-identity-only-every-line-keyed-within-item-margins-and-line-quantities-else-whole',
  partialRefundAttribution: REFUND_ATTRIBUTION_POLICY_DIGEST,
}) satisfies RefundCreditPolicy;
export const REFUND_CREDIT_POLICY_DIGEST = digest(REFUND_CREDIT_POLICY);

export const REFUND_HOLD_REASONS = ['no-candidate', 'ambiguous-order', 'order-unprovable', 'card-unproven',
  'ambiguous-subset', 'capacity-exceeded'] as const;
export type RefundHoldReason = (typeof REFUND_HOLD_REASONS)[number];
export const REFUND_ORDER_PROOFS = ['refund-summary', 'full-order', 'subset'] as const;
export type RefundOrderProof = (typeof REFUND_ORDER_PROOFS)[number];

/** A priced order line: the item ID (else the line ordinal) as key, its unit price and quantity. */
export interface RefundLine { key: string; unitMinor: number; qty: number | null }
export interface RefundOrder {
  ref: string;
  date: string;
  /** The window end of the capture the order's latest observation came from. */
  observedThrough: string | null;
  totalMinor: number | null;
  refundSummaryMinor: number | null;
  itemsSubtotalMinor: number | null;
  taxMinor: number;
  /** A non-zero promotion, gift-card or rewards summary entry: refunds are prorated, so no unit subset proves. */
  adjustments: boolean;
  /**
   * The order summary is proven complete (closed block, explicit USD subtotal, shipping, tax and grand total that add
   * up exactly): only then are its tax and absence of adjustments known, so only then can a unit subset prove.
   */
  summaryProven: boolean;
  itemsComplete: boolean;
  lines: readonly RefundLine[];
  tender: 'single-card-proven' | 'other';
  /** Card accounts of the order's linked charges, and of its proven refund destinations. */
  chargeCards: readonly string[];
  destinationCards: readonly string[];
  /** Its own history conflicts: it still competes for credits it could explain, but never proves one. */
  contradictory: boolean;
  /**
   * The most any observation in its history could explain (total, refund total, items subtotal plus tax): an order
   * that cannot be searched competes up to it, so a contradictory order keeps competing on an older, larger total.
   */
  historyBoundMinor?: number | null;
}
export interface RefundCreditCandidate {
  id: string;
  cardAccountId: string;
  date: string;
  /** Positive: the credit's absolute amount. */
  amountMinor: number;
  inScope: boolean;
  alreadyLinked: boolean;
}
export type RefundItemSet = ReadonlyArray<{ key: string; unitMinor: number; units: number }>;
export type RefundDecision =
  | { outcome: 'out-of-scope' }
  | { outcome: 'already-linked' }
  | { outcome: 'held'; reason: RefundHoldReason; candidates: number }
  | { outcome: 'linked'; orderRef: string; proof: string; itemAttribution: 'unique' | 'held'; attribution: RefundItemSet | null;
    lagDays: number; candidates: 1 };

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const DAY_MS = 86400000;
/** Whole calendar days from one ISO date to another. */
export const lagDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * A pre-tax base's share of the order tax, base * tax / items subtotal rounded half up to the cent, in integers: the
 * shared taxShare (integerShares.ts), under this domain's name and signature.
 */
export const taxShare: (baseMinor: number, taxMinor: number, itemsSubtotalMinor: number | null) => number = sharedTaxShare;
/**
 * The tax-inclusive amount of `units` units of one line: the share is taken on the line's units together. The shared
 * lineAmount (integerShares.ts), under this domain's name and signature.
 */
export const lineAmount: (order: Pick<RefundOrder, 'taxMinor' | 'itemsSubtotalMinor'>, line: RefundLine, units: number) => number =
  sharedLineAmount;
const SEP = '\u0000';
const lineKey = (l: { key: string; unitMinor: number }) => `${l.key}${SEP}${l.unitMinor}`;
/** An item multiset: lines of the same key and unit price merge, sorted, zero counts dropped. */
function itemSet(order: RefundOrder, units: readonly number[]): RefundItemSet {
  const merged = new Map<string, number>();
  order.lines.forEach((l, i) => { if (units[i] > 0) merged.set(lineKey(l), (merged.get(lineKey(l)) ?? 0) + units[i]); });
  return [...merged].sort(([a], [b]) => byText(a, b)).map(([k, units]) => {
    const [key, unit] = k.split(SEP);
    return { key, unitMinor: Number(unit), units };
  });
}
export function subsetEvaluable(order: RefundOrder, policy: RefundCreditPolicy = REFUND_CREDIT_POLICY): boolean {
  if (order.contradictory || !order.summaryProven || !order.itemsComplete || order.adjustments || !positive(order.itemsSubtotalMinor)) return false;
  if (order.lines.length === 0 || order.lines.length > policy.maxLines) return false;
  if (order.lines.some(l => !positive(l.unitMinor) || !positive(l.qty))) return false;
  let combos = 1;
  for (const l of order.lines) {
    combos *= l.qty! + 1;
    if (combos - 1 > policy.maxCombos) return false;
  }
  return true;
}
/** Every distinct item multiset whose tax-inclusive amount is exactly `amountMinor` (none when not evaluable). */
export function subsetItemSets(order: RefundOrder, amountMinor: number, policy: RefundCreditPolicy = REFUND_CREDIT_POLICY):
  Map<string, RefundItemSet> {
  const found = new Map<string, RefundItemSet>();
  if (!subsetEvaluable(order, policy)) return found;
  const units = order.lines.map(() => 0);
  const walk = (i: number, sum: number): void => {
    if (sum > amountMinor) return;
    if (i === order.lines.length) {
      if (sum === amountMinor && units.some(u => u > 0)) {
        const set = itemSet(order, units);
        found.set(JSON.stringify(set), set);
      }
      return;
    }
    for (let u = 0; u <= order.lines[i].qty!; u++) {
      units[i] = u;
      walk(i + 1, sum + (u > 0 ? lineAmount(order, order.lines[i], u) : 0));
    }
    units[i] = 0;
  };
  walk(0, 0);
  return found;
}
/**
 * An order's unit subsets enumerated once, by tax-inclusive amount: the first item set and whether a different one
 * exists (only uniqueness is ever asked). At most `maxCombos` subsets, however many credits ask.
 */
export interface SubsetIndex {
  evaluable: boolean;
  byAmount: ReadonlyMap<number, { set: RefundItemSet; key: string; count: 1 | 2 }>;
}
export function subsetIndex(order: RefundOrder, policy: RefundCreditPolicy = REFUND_CREDIT_POLICY): SubsetIndex {
  const byAmount = new Map<number, { set: RefundItemSet; key: string; count: 1 | 2 }>();
  if (!subsetEvaluable(order, policy)) return { evaluable: false, byAmount };
  const groupOf = itemGroups(order), counts = new Array<number>(Math.max(0, ...groupOf) + 1).fill(0);
  const units = order.lines.map(() => 0);
  const walk = (i: number, sum: number): void => {
    if (i === order.lines.length) {
      if (!units.some(u => u > 0)) return;
      const key = counts.join(','), entry = byAmount.get(sum);
      // Only the first item set of an amount is ever built; a second one only needs telling apart.
      if (!entry) byAmount.set(sum, { set: itemSet(order, units), key, count: 1 });
      else if (entry.key !== key) entry.count = 2;
      return;
    }
    for (let u = 0; u <= order.lines[i].qty!; u++) {
      units[i] = u;
      counts[groupOf[i]] += u;
      walk(i + 1, sum + (u > 0 ? lineAmount(order, order.lines[i], u) : 0));
      counts[groupOf[i]] -= u;
    }
    units[i] = 0;
  };
  walk(0, 0);
  return { evaluable: true, byAmount };
}
/** Each line's item group: lines of the same key and unit price are one item, as item sets merge them. */
function itemGroups(order: RefundOrder): number[] {
  const groups = new Map<string, number>();
  return order.lines.map(l => {
    if (!groups.has(lineKey(l))) groups.set(lineKey(l), groups.size);
    return groups.get(lineKey(l))!;
  });
}
/** The item-set key of the whole order (every unit of every line), as `subsetIndex` keys its sets. */
function wholeOrderKey(order: RefundOrder): string {
  const groupOf = itemGroups(order), counts = new Array<number>(Math.max(0, ...groupOf) + 1).fill(0);
  order.lines.forEach((l, i) => { counts[groupOf[i]] += l.qty!; });
  return counts.join(',');
}
function evaluate(order: RefundOrder, amountMinor: number, index: SubsetIndex) {
  const found = index.byAmount.get(amountMinor);
  let attribution: RefundItemSet | null = found?.count === 1 ? found.set : null;
  const proofs: RefundOrderProof[] = [];
  if (!order.contradictory) {
    if (order.refundSummaryMinor === amountMinor) proofs.push('refund-summary');
    if (order.totalMinor === amountMinor) {
      proofs.push('full-order');
      if (order.itemsComplete && order.lines.length > 0 && order.lines.every(l => positive(l.qty))) {
        if (!found) attribution = itemSet(order, order.lines.map(l => l.qty!));
        else if (found.key !== wholeOrderKey(order)) attribution = null;
      }
    }
    if (found) proofs.push('subset');
  }
  const proven = proofs.length > 0;
  let possible = proven;
  if (!proven && !index.evaluable) {
    // An order whose unit subsets cannot be enumerated still competes when the amount could be part of it, by its own
    // latest amounts or by anything its history ever showed (a contradictory order's older total included).
    const bound = Math.max(order.totalMinor ?? 0, order.refundSummaryMinor ?? 0,
      positive(order.itemsSubtotalMinor) ? order.itemsSubtotalMinor + (positive(order.taxMinor) ? order.taxMinor : 0) : 0,
      order.historyBoundMinor ?? 0);
    possible = bound === 0 || amountMinor <= bound;
  }
  return { proofs, proven, possible, attribution };
}
/**
 * `same`: a linked charge of the order, or a proven refund destination, is on the credit's card. `other`: the order's
 * linked charges are on other cards and its tender is single-card proven, so it is no candidate. `unknown` otherwise.
 */
export function refundCardRelation(order: RefundOrder, cardAccountId: string): 'same' | 'other' | 'unknown' {
  if (order.chargeCards.includes(cardAccountId) || order.destinationCards.includes(cardAccountId)) return 'same';
  if (order.chargeCards.length > 0 && order.tender === 'single-card-proven') return 'other';
  return 'unknown';
}
/** A ledger `Refunded` link already on an order: its amount, and its card row's date. */
export interface RefundExistingClaim { amountMinor: number; date: string }
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/**
 * Each credit's decision over every order, independent of input order. `existingClaims`: per order, the ledger
 * `Refunded` links already on it. They count against its capacity by amount and by the units their amount names, and
 * their dates count when deciding whether the refund total was observed after every claim.
 */
export function decideRefundCredits(input: { orders: readonly RefundOrder[]; credits: readonly RefundCreditCandidate[];
  existingClaims?: ReadonlyMap<string, readonly RefundExistingClaim[]> }, policy: RefundCreditPolicy = REFUND_CREDIT_POLICY):
  Map<string, RefundDecision> {
  const dated = input.orders.filter(o => day(o.date)).map(order => ({ order, n: dayNumber(order.date) }))
    .sort((a, b) => a.n - b.n || byText(a.order.ref, b.order.ref));
  const credits = [...input.credits].sort((a, b) => byText(a.id, b.id));
  const indexes = new Map<RefundOrder, SubsetIndex>();
  const indexOf = (order: RefundOrder) => {
    let index = indexes.get(order);
    if (!index) indexes.set(order, index = subsetIndex(order, policy));
    return index;
  };
  const out = new Map<string, RefundDecision>();
  type Competitor = { order: RefundOrder; ev: ReturnType<typeof evaluate>; card: 'same' | 'unknown'; lag: number };
  const tentative: Array<{ credit: RefundCreditCandidate; k: Competitor; attribution: RefundItemSet | null }> = [];
  for (const credit of credits) {
    if (!credit.inScope || !positive(credit.amountMinor) || !day(credit.date)) { out.set(credit.id, { outcome: 'out-of-scope' }); continue; }
    if (credit.alreadyLinked) { out.set(credit.id, { outcome: 'already-linked' }); continue; }
    const competitors: Competitor[] = [];
    // Only orders dated inside the credit's window are looked at: the first one by binary search, then in date order.
    const latest = dayNumber(credit.date) - policy.minLagDays, earliest = dayNumber(credit.date) - policy.maxLagDays;
    let lo = 0, hi = dated.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dated[mid].n < earliest) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < dated.length && dated[i].n <= latest; i++) {
      const { order, n } = dated[i];
      // An order whose charges are on other cards is no candidate, whatever it could explain: skip its search.
      const card = refundCardRelation(order, credit.cardAccountId);
      if (card === 'other') continue;
      const ev = evaluate(order, credit.amountMinor, indexOf(order));
      if (!ev.possible) continue;
      competitors.push({ order, ev, card, lag: dayNumber(credit.date) - n });
    }
    const provenSameCard = competitors.filter(k => k.ev.proven && k.card === 'same');
    // An exact refund-total match on the order's own card outranks orders that could only possibly explain the amount.
    const literalPool = policy.competitors === 'literal' || (policy.competitors === 'hybrid'
      && provenSameCard.some(k => k.ev.proofs.includes('refund-summary')));
    const pool = literalPool ? provenSameCard : competitors;
    if (pool.length > 1) { out.set(credit.id, { outcome: 'held', reason: 'ambiguous-order', candidates: pool.length }); continue; }
    if (pool.length === 0) {
      const reason = competitors.some(k => k.ev.proven) ? 'card-unproven' : competitors.length ? 'order-unprovable' : 'no-candidate';
      out.set(credit.id, { outcome: 'held', reason, candidates: 0 });
      continue;
    }
    const [k] = pool;
    if (!k.ev.proven) { out.set(credit.id, { outcome: 'held', reason: 'order-unprovable', candidates: 1 }); continue; }
    if (k.card !== 'same') { out.set(credit.id, { outcome: 'held', reason: 'card-unproven', candidates: 1 }); continue; }
    const attribution = k.ev.attribution;
    const orderLevel = k.ev.proofs.includes('refund-summary') || k.ev.proofs.includes('full-order');
    if (!orderLevel && attribution === null) { out.set(credit.id, { outcome: 'held', reason: 'ambiguous-subset', candidates: 1 }); continue; }
    tentative.push({ credit, k, attribution });
  }
  // Capacity: every claim on one order, ledger links included, must fit its refund total (when observed on or after
  // every claim) else its grand total, and every line's quantity. Any excess holds every new claim on that order.
  const byOrder = new Map<string, typeof tentative>();
  for (const t of tentative) byOrder.set(t.k.order.ref, [...(byOrder.get(t.k.order.ref) ?? []), t]);
  for (const [orderRef, claims] of [...byOrder].sort(([a], [b]) => byText(a, b))) {
    const order = claims[0].k.order, existing = input.existingClaims?.get(orderRef) ?? [];
    const last = [...claims.map(t => t.credit.date), ...existing.map(e => e.date)].sort(byText).at(-1)!;
    const sum = claims.reduce((n, t) => n + t.credit.amountMinor, existing.reduce((n, e) => n + e.amountMinor, 0));
    const cap = positive(order.refundSummaryMinor) && order.observedThrough !== null && day(order.observedThrough)
      && order.observedThrough >= last ? order.refundSummaryMinor : positive(order.totalMinor) ? order.totalMinor : Infinity;
    const capacity = new Map<string, number>(), used = new Map<string, number>();
    const use = (set: RefundItemSet) => { for (const e of set) used.set(lineKey(e), (used.get(lineKey(e)) ?? 0) + e.units); };
    for (const l of order.lines) capacity.set(lineKey(l), (capacity.get(lineKey(l)) ?? 0) + (positive(l.qty) ? l.qty : 0));
    // A ledger link consumes the units its amount uniquely names; when it names none uniquely, no new claim's units can
    // be checked against the quantities, so a new claim with units does not fit.
    let unitsUnknown = false;
    for (const e of existing) {
      const named = evaluate(order, e.amountMinor, indexOf(order)).attribution;
      if (named) use(named);
      else unitsUnknown = true;
    }
    for (const t of claims) if (t.attribution) use(t.attribution);
    const over = sum > cap || [...used].some(([key, n]) => n > (capacity.get(key) ?? 0))
      || (unitsUnknown && claims.some(t => t.attribution !== null));
    for (const t of claims) {
      out.set(t.credit.id, over ? { outcome: 'held', reason: 'capacity-exceeded', candidates: 1 }
        : { outcome: 'linked', orderRef, proof: t.k.ev.proofs.join('+'), itemAttribution: t.attribution ? 'unique' : 'held',
          attribution: t.attribution, lagDays: t.k.lag, candidates: 1 });
    }
  }
  return new Map([...out].sort(([a], [b]) => byText(a, b)));
}

/** A linked charge of the order the credits refund, with the item allocation Spending filed it under. */
export interface RefundCharge {
  id: string;
  amountMinor: number;
  currency: string;
  /** Accepted as an item split, with no card category of the owner's own. */
  itemized: boolean;
  allocations: ReadonlyArray<Pick<Allocation, 'itemRef' | 'amountMinor' | 'currency' | 'sourceCategory'>>;
}
/** A credit's negative item part: the opposite of what the reversed charges filed under that item. */
export interface RefundPart {
  itemRef: string;
  amountMinor: number;
  currency: string;
  sourceCategory: string | null;
  classification: 'policy-allocated';
}
/**
 * One observation of the order and the capture it came from. A charge's item parts name its lines by their
 * capture-scoped refs, `opaque('line-observation', [captureDigest, orderId, lineOrdinal])`.
 */
export interface RefundOrderSnapshot { captureDigest: string; order: OrderObservation }
export type RefundItemization =
  | { kind: 'mirror'; parts: RefundPart[] }
  | { kind: 'split'; basis: 'whole-order' | 'units' | 'only-line'; parts: RefundPart[] }
  | { kind: 'whole'; reason: 'refund-unattributed' | 'inconsistent-evidence' | 'currency-mismatch' };
type Margins = ReadonlyMap<string, { amount: bigint; sourceCategory: string | null }>;
const UNATTRIBUTED = Object.freeze({ kind: 'whole', reason: 'refund-unattributed' } as const);
const INCONSISTENT = Object.freeze({ kind: 'whole', reason: 'inconsistent-evidence' } as const);

/**
 * The item parts of the credits linked to one order. Items are only ever the order's linked card charges' own, and
 * only while every one of those charges is itemized (an accepted split, no card category of the owner's own); credits
 * adding up to more than the charges (or the order total) contradict the evidence.
 * - A refund of everything the charges paid negates each item's margin across the charges, spread over the credits
 *   (in card-row order) by the charge policy's own stable largest remainder: one credit takes the margins exactly, and
 *   a tied cent goes by the charges' own line identity (order-history v3's `lineTieKeys`, on the observation they were
 *   allocated on, else each part's own observation), never by a capture-scoped ref, so re-reading the order moves no
 *   cent between a credit's items. A part with no stable key keeps every credit of the order whole (STEP 9 integration B5).
 * - A partial refund is split credit by credit by the refund attribution module (`splitRefund`, one refund payment's
 *   scope) on the observation the charges were allocated on, each line's money under that line's ref: the charges'
 *   own item. See `splitPartialRefund`.
 * STEP 9 integration B5 (Root): either way a credit's parts are listed by that line identity, so a re-read lists them alike.
 * STEP 9 integration B5 (Root): the ONE source of every tie key is `lineTies`, the history reader's per-order map with
 * conflicting keys removed (`RefundEvidence.lineTies`); no path rebuilds a key from a selected observation. No map, or a
 * part without its own distinct key, keeps every credit of the order whole (refund-unattributed).
 */
export function itemizeRefundCredits(credits: ReadonlyArray<{ id: string; amountMinor: number; currency: string }>,
  charges: readonly RefundCharge[], orderTotal: Money | null, snapshots: readonly RefundOrderSnapshot[],
  lineTies: ReadonlyMap<string, string | null> | undefined): Map<string, RefundItemization> {
  const answer = new Map<string, RefundItemization>();
  const all = (value: RefundItemization) => {
    for (const credit of credits) answer.set(credit.id, value);
    return answer;
  };
  if (!credits.length) return answer;
  const currency = credits[0].currency;
  if (credits.some(c => c.currency !== currency) || charges.some(c => c.currency !== currency)
    || (orderTotal !== null && orderTotal.currency !== currency)) return all({ kind: 'whole', reason: 'currency-mismatch' });
  if (credits.some(c => !minor(c.amountMinor) || c.amountMinor >= 0) || charges.some(c => !minor(c.amountMinor) || c.amountMinor <= 0)
    || (orderTotal !== null && !minor(orderTotal.amountMinor))) return all(INCONSISTENT);
  const refunded = credits.reduce((n, c) => n - BigInt(c.amountMinor), 0n);
  const paid = charges.reduce((n, c) => n + BigInt(c.amountMinor), 0n);
  if ((charges.length > 0 && refunded > paid) || (orderTotal !== null && refunded > BigInt(orderTotal.amountMinor))) return all(INCONSISTENT);
  if (!charges.length || charges.some(c => !c.itemized)) return all(UNATTRIBUTED);
  const margins = new Map<string, { amount: bigint; sourceCategory: string | null }>();
  for (const charge of charges) {
    let sum = 0n;
    for (const a of charge.allocations) {
      if (!ref(a.itemRef) || !minor(a.amountMinor) || a.amountMinor < 0 || a.currency !== currency) return all(INCONSISTENT);
      const margin = margins.get(a.itemRef);
      if (margin && margin.sourceCategory !== a.sourceCategory) return all(INCONSISTENT);
      margins.set(a.itemRef, { amount: (margin?.amount ?? 0n) + BigInt(a.amountMinor), sourceCategory: a.sourceCategory });
      sum += BigInt(a.amountMinor);
    }
    if (sum !== BigInt(charge.amountMinor)) return all(INCONSISTENT);
  }
  const remaining = new Map([...margins].filter(([, m]) => m.amount > 0n).map(([itemRef, m]) => [itemRef, m.amount]));
  if (!remaining.size || [...remaining.values()].some(n => n > BigInt(Number.MAX_SAFE_INTEGER))) return all(INCONSISTENT);
  const observation = chargeObservation(margins, snapshots);
  if (refunded !== paid) return splitPartialRefund(credits, currency, paid, margins, observation, lineTies);
  // STEP 9 integration B5 (Root): a tied cent goes where the charges' own rounding sends it, by stable line identity, and
  // only by the history reader's keys (`lineTies`): never one rebuilt from the observation the charges rest on, never a
  // capture-scoped ref. No map, a part without its key (none, or removed as conflicting), or two parts with one, keeps
  // every credit of the order whole.
  const ties = new Map<string, string>();
  for (const itemRef of remaining.keys()) {
    const key = lineTies?.get(itemRef);
    if (typeof key === 'string') ties.set(itemRef, key);
  }
  if (ties.size !== remaining.size || new Set(ties.values()).size !== remaining.size) return all(UNATTRIBUTED);
  for (const credit of [...credits].sort((a, b) => byText(a.id, b.id))) {
    const portions = largestRemainder(-credit.amountMinor, [...remaining].filter(([, n]) => n > 0n)
      .map(([itemRef, n]) => ({ ref: itemRef, weight: Number(n), tie: ties.get(itemRef)! })));
    const parts: RefundPart[] = [];
    // STEP 9 integration B5 (Root): a credit's parts are listed by line identity too, never by capture-scoped ref.
    for (const [itemRef, n] of [...portions].sort(([a], [b]) => byText(ties.get(a)!, ties.get(b)!))) {
      if (!n) continue;
      remaining.set(itemRef, remaining.get(itemRef)! - BigInt(n));
      parts.push({ itemRef, amountMinor: -n, currency, sourceCategory: margins.get(itemRef)!.sourceCategory,
        classification: 'policy-allocated' });
    }
    answer.set(credit.id, { kind: 'mirror', parts });
  }
  if ([...remaining.values()].some(n => n !== 0n)) throw Error('amazon refund conservation refused');
  return answer;
}
/**
 * The observation the charges were allocated on: of those offered (`orderChargeSnapshots`), the one whose lines'
 * capture-scoped refs carry every item ref the charges filed, with its refs by line ordinal. Null when none does, or
 * when two different observations would.
 */
function chargeObservation(margins: Margins, snapshots: readonly RefundOrderSnapshot[]):
  { order: OrderObservation; refs: ReadonlyMap<number, string> } | null {
  const filed = [...margins.keys()];
  const covering = snapshots.map(s => ({ order: s.order, refs: new Map(s.order.items.flatMap(i => Number.isInteger(i.lineOrdinal)
    ? [[i.lineOrdinal!, opaque('line-observation', [s.captureDigest, s.order.orderId, i.lineOrdinal])] as const] : [])) }))
    .filter(s => {
      const named = new Set(s.refs.values());
      return filed.every(itemRef => named.has(itemRef));
    });
  return covering.length && new Set(covering.map(s => digest(s.order))).size === 1 ? covering[0] : null;
}
/**
 * A partial refund's item parts, credit by credit. Each credit is one refund payment, split over the lines it paid
 * back by `splitRefund(order, credit, 'payment')` (refundAttribution.ts, the only attribution rule) on the observation
 * the charges were allocated on (`chargeObservation`). Each line's money is filed, negated and `policy-allocated`,
 * under that line's ref, so under the charge's own item and category. No such single observation, a held attribution,
 * or a line the charges filed nothing under keeps the credit whole (`refund-unattributed`). Credits that together give
 * an item back more than its charges filed under it, or a line more units than it had, contradict the evidence: every
 * credit of the order stays whole.
 * STEP 9 integration B5 (Root): each line's tie key comes from `lineTies` (the history reader's), the ONE key source.
 */
function splitPartialRefund(credits: ReadonlyArray<{ id: string; amountMinor: number }>, currency: string, paid: bigint,
  margins: Margins, observation: ReturnType<typeof chargeObservation>,
  lineTies: ReadonlyMap<string, string | null> | undefined): Map<string, RefundItemization> {
  const answer = new Map<string, RefundItemization>();
  const all = (value: RefundItemization) => {
    for (const credit of credits) answer.set(credit.id, value);
    return answer;
  };
  if (!observation) return all(UNATTRIBUTED);
  const { order, refs } = observation;
  // The charges were allocated on this observation: it is in their currency and its total covers what they paid.
  if (!order.total || !minor(order.total.amountMinor)) return all(INCONSISTENT);
  if (order.total.currency !== currency) return all({ kind: 'whole', reason: 'currency-mismatch' });
  if (BigInt(order.total.amountMinor) < paid) return all(INCONSISTENT);
  const given = new Map<string, bigint>(), units = new Map<number, number>();
  // STEP 9 integration B5 (Root): a tied cent goes by the charges' own line identity, as in the full-refund mirror, and
  // only by the history reader's key for each line's ref (`lineTies`), never one rebuilt from this observation. A line
  // without its key holds the split (shares()), so the credit stays whole.
  const ties = new Map<number, string>();
  for (const [lineOrdinal, itemRef] of refs) {
    const key = lineTies?.get(itemRef);
    if (typeof key === 'string') ties.set(lineOrdinal, key);
  }
  for (const credit of [...credits].sort((a, b) => byText(a.id, b.id))) {
    const split = splitRefund(order, { currency, amountMinor: credit.amountMinor }, 'payment', ties);
    if (split.kind !== 'split') { answer.set(credit.id, UNATTRIBUTED); continue; }
    const lines = split.lines.map(line => ({ ...line, itemRef: refs.get(line.lineOrdinal) }));
    // STEP 9 integration B5 (Root): every line it files has a line identity to be listed by, else the credit stays whole.
    if (!lines.length || lines.some(l => l.itemRef === undefined || !margins.has(l.itemRef) || !ties.has(l.lineOrdinal))
      || lines.reduce((n, l) => n + BigInt(l.amountMinor), 0n) !== -BigInt(credit.amountMinor)) {
      answer.set(credit.id, UNATTRIBUTED);
      continue;
    }
    const parts: Array<[tie: string, part: RefundPart]> = [];
    for (const line of lines) {
      const itemRef = line.itemRef!;
      given.set(itemRef, (given.get(itemRef) ?? 0n) + BigInt(line.amountMinor));
      if (line.units !== null) units.set(line.lineOrdinal, (units.get(line.lineOrdinal) ?? 0) + line.units);
      parts.push([ties.get(line.lineOrdinal)!, { itemRef, amountMinor: -line.amountMinor, currency,
        sourceCategory: margins.get(itemRef)!.sourceCategory, classification: 'policy-allocated' }]);
    }
    // STEP 9 integration B5 (Root): listed by line identity, never by capture-scoped ref, so a re-read lists them alike.
    answer.set(credit.id, { kind: 'split', basis: split.basis, parts: parts.sort(([a], [b]) => byText(a, b)).map(([, part]) => part) });
  }
  const quantities = new Map(order.items.map(i => [i.lineOrdinal, i.quantity]));
  if ([...given].some(([itemRef, n]) => n > margins.get(itemRef)!.amount)
    || [...units].some(([lineOrdinal, n]) => n > (quantities.get(lineOrdinal) ?? 0))) return all(INCONSISTENT);
  return answer;
}

/** The order facts a credit decision needs, from each order's latest observation; cards come from the live match. */
export interface RefundOrderFacts extends Omit<RefundOrder, 'chargeCards' | 'destinationCards'> {
  total: Money | null;
}
export interface RefundEvidence {
  orders: RefundOrderFacts[];
  /** Per order: bound card accounts its completed refunds were stated to go to (order or returns pages). */
  statedDestinations: Map<string, string[]>;
  /** Per order: the observations its charges' item allocations can rest on (`orderChargeSnapshots`). */
  chargeSnapshots: Map<string, RefundOrderSnapshot[]>;
  /**
   * STEP 9 integration B5 (Root): per order, each observed line's stable tie key (order-history v3's lineTieKeys: order,
   * exact title, occurrence) by its capture-scoped item ref, from every observation of the order.
   * STEP 9 integration B5 (Root): a ref the observations disagree on has none: it stays, explicitly null (contested), and
   * every observed order keeps its entry, so no absent or empty map can ever read as "no conflict".
   */
  lineTies: Map<string, Map<string, string | null>>;
}
/**
 * The observations an order's charges can have been allocated on, chosen as each charge policy chooses: the
 * order-total policy's `selectOrderTotalSnapshot`, and the ledger policy's first observation with `ledgerOrderProof`,
 * else the latest stored one. Only observations with lines; `itemizeRefundCredits` keeps the one whose lines' refs
 * are the charges' item refs, so a choice no charge made never files anything. STEP 9 integration (#154 x #168): both
 * policies choose the displayed observation (`latest`, the stored one) first, as the matcher's subjects and the ledger
 * allocation do, so an order whose display a later complete read could not replace still offers what its charges rest on.
 */
export function orderChargeSnapshots(history: readonly OrderSnapshot[], latest: RefundOrderSnapshot): RefundOrderSnapshot[] {
  const displayed = latest.captureDigest;
  const chosen = [selectOrderTotalSnapshot(history, displayed), history.find(s => s.captureDigest === displayed && ledgerOrderProof(s.order))
    ?? history.find(s => ledgerOrderProof(s.order)) ?? latest];
  return chosen.filter((s, n): s is RefundOrderSnapshot => s !== undefined && s.order.items.length > 0 && chosen.indexOf(s) === n)
    .map(s => ({ captureDigest: s.captureDigest, order: s.order }));
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function parse(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
/** The one approved card account a method names, if exactly one. */
function boundCard(m: unknown, bindings: readonly Binding[]): string | null {
  if (!plain(m) || m.kind !== 'card' || typeof m.network !== 'string' || typeof m.last4 !== 'string') return null;
  const method = m as unknown as Method;
  const bound = bindings.filter(b => b.network === method.network && b.last4 === method.last4);
  return bound.length === 1 ? bound[0].cardAccountId : null;
}
const usd = (money: Money | null | undefined): number | null =>
  money && money.currency === 'USD' && minor(money.amountMinor) ? money.amountMinor : null;
/**
 * The order summary's tax and adjustments, only when the summary itself is proven: a complete, conflict-free closed
 * block with explicit USD items subtotal, shipping, tax and grand total (no absent-component zero), no negative
 * component but a gift-card or rewards share, and exact purchase arithmetic, as `ledgerOrderProof` requires.
 */
function provenSummary(order: OrderObservation): { taxMinor: number; adjustments: boolean } | null {
  const proof = order.tenderProof, summary = order.summary ?? [], total = usd(order.total);
  if (!proof?.summaryComplete || proof.unknownSummary || proof.conflict || total === null || total <= 0) return null;
  const amounts = new Map<string, number | null>(summary.map(s => [s.kind, usd(s.money)]));
  if (amounts.size !== summary.length || [...amounts.values()].some(n => n === null)
    || ['items-subtotal', 'shipping', 'tax', 'grand-total'].some(kind => !amounts.has(kind))
    || summary.some(s => !['gift-card', 'rewards'].includes(s.kind) && s.money.amountMinor < 0)) return null;
  const amount = (kind: string) => BigInt(amounts.get(kind) ?? 0);
  if (amount('items-subtotal') + amount('shipping') + amount('tax') - amount('promotion') !== BigInt(total)
    || amount('grand-total') !== BigInt(total)) return null;
  return { taxMinor: Number(amount('tax')),
    adjustments: summary.some(s => ['promotion', 'gift-card', 'rewards'].includes(s.kind) && s.money.amountMinor !== 0) };
}
/** A refund total observed lower than an earlier one, or in another currency, contradicts the order's history. */
export function refundTotalsContradict(newestFirst: readonly OrderObservation[]): boolean {
  const totals = [...newestFirst].reverse().flatMap(o => o.refundSummary ? [o.refundSummary] : []);
  return totals.some((r, i) => i > 0 && (r.currency !== totals[i - 1].currency || r.amountMinor < totals[i - 1].amountMinor));
}

/** One order's facts from its latest observation (`format`: that capture's format version). */
export function refundOrderFacts(orderRef: string, order: OrderObservation, observedThrough: string | null, format: number,
  conflict: boolean, historyBoundMinor: number | null = null): RefundOrderFacts {
  const summary = new Map((order.summary ?? []).map(s => [s.kind, s.money]));
  const total = order.total && minor(order.total.amountMinor) ? order.total : null;
  const refund = usd(order.refundSummary);
  const proven = provenSummary(order);
  return {
    ref: orderRef, date: order.date, observedThrough, total,
    totalMinor: usd(total), refundSummaryMinor: refund !== null && refund > 0 ? refund : null,
    itemsSubtotalMinor: usd(summary.get('items-subtotal')),
    // An unproven summary's tax only bounds what the order could explain; it never proves a unit subset.
    taxMinor: proven ? proven.taxMinor : usd(summary.get('tax')) ?? 0,
    adjustments: proven ? proven.adjustments
      : (order.summary ?? []).some(s => ['promotion', 'gift-card', 'rewards'].includes(s.kind) && s.money.amountMinor !== 0),
    summaryProven: proven !== null,
    itemsComplete: itemBlockReconciles(order),
    lines: order.items.filter(i => i.unitPrice?.currency === 'USD' && positive(i.unitPrice.amountMinor))
      .map(i => ({ key: i.itemId ?? `line:${i.lineOrdinal}`, unitMinor: i.unitPrice!.amountMinor, qty: positive(i.quantity) ? i.quantity : null })),
    tender: format === 3 && order.tenderCoverage === 'single-card-proven' && singleCardProven(order) ? 'single-card-proven' : 'other',
    contradictory: conflict,
    historyBoundMinor,
  };
}
/** The most any observation of an order could explain: its total, refund total, or items subtotal plus tax. */
export function orderHistoryBound(observations: readonly OrderObservation[]): number | null {
  let bound: number | null = null;
  for (const o of observations) {
    const summary = new Map((o.summary ?? []).map(s => [s.kind, usd(s.money)]));
    const subtotal = summary.get('items-subtotal') ?? null, tax = summary.get('tax') ?? null;
    for (const amount of [usd(o.total), usd(o.refundSummary), subtotal !== null && subtotal > 0 ? subtotal + (tax !== null && tax > 0 ? tax : 0) : null]) {
      if (amount !== null && amount > 0 && Number.isSafeInteger(amount)) bound = Math.max(bound ?? 0, amount);
    }
  }
  return bound;
}

/**
 * Reads, never writes: every order's latest observation (with its capture's window end and format, and whether its
 * history conflicts), the observations its charges can have been allocated on, and the bound card destinations
 * stated for its completed refunds.
 */
export function readRefundEvidence(db: Database, bindings: readonly Binding[]): RefundEvidence {
  const histories = new Map<string, OrderSnapshot[]>();
  for (const row of db.prepare(`SELECT o.order_ref,o.capture_digest,o.data_json,o.hold_reason,c.format_version
    FROM amazon_observations o JOIN amazon_captures c ON c.digest=o.capture_digest WHERE o.family='order' AND o.order_ref IS NOT NULL
    ORDER BY o.order_ref,c.rowid DESC,o.ordinal DESC`).all() as
    Array<{ order_ref: string; capture_digest: string; data_json: string; hold_reason: string; format_version: number }>) {
    histories.set(row.order_ref, [...(histories.get(row.order_ref) ?? []), { order: JSON.parse(row.data_json) as OrderObservation,
      captureDigest: row.capture_digest, version: row.format_version, scope: observationScope(row.hold_reason) }]);
  }
  const chargeSnapshots = new Map<string, RefundOrderSnapshot[]>();
  const orders = (db.prepare(`SELECT o.ref,o.latest_digest,o.data_json,c.window_through,c.format_version FROM amazon_orders o
    JOIN amazon_captures c ON c.digest=o.latest_digest ORDER BY o.ref`).all() as
    Array<{ ref: string; latest_digest: string; data_json: string; window_through: string; format_version: number }>)
    .map(row => {
      // The purchase history policy leaves refund totals out on purpose; a shrinking refund total contradicts too.
      const history = histories.get(row.ref) ?? [], observed = history.map(h => h.order);
      const latest = JSON.parse(row.data_json) as OrderObservation;
      const snapshots = orderChargeSnapshots(history, { captureDigest: row.latest_digest, order: latest });
      if (snapshots.length) chargeSnapshots.set(row.ref, snapshots);
      return refundOrderFacts(row.ref, latest, day(row.window_through) ? row.window_through : null,
        row.format_version, orderHistoryConflicts(history) || refundTotalsContradict(observed), orderHistoryBound(observed));
    });
  const statedDestinations = new Map<string, string[]>();
  const destinations = new Map<string, Array<{ kind: string; data_json: string }>>();
  for (const row of db.prepare('SELECT refund_ref,kind,data_json FROM amazon_refund_destinations ORDER BY ref').all() as
    Array<{ refund_ref: string; kind: string; data_json: string }>) {
    destinations.set(row.refund_ref, [...(destinations.get(row.refund_ref) ?? []), row]);
  }
  for (const row of db.prepare('SELECT ref,data_json FROM amazon_refunds ORDER BY ref').all() as Array<{ ref: string; data_json: string }>) {
    const value = parse(row.data_json);
    // Only a completed refund an order or returns page states, for exactly one order, names a destination.
    // STEP 9 integration (B5)
    if (!plain(value) || !plain(value.provenance) || typeof value.provenance.source !== 'string'
      || !['order-details', 'returns-page'].includes(value.provenance.source)
      || value.kind !== 'refund' || value.status !== 'completed' || !Array.isArray(value.orderIds) || value.orderIds.length !== 1
      || typeof value.orderIds[0] !== 'string' || !value.orderIds[0]) continue;
    const orderRef = opaque('order', value.orderIds[0]);
    for (const d of destinations.get(row.ref) ?? []) {
      const stated = parse(d.data_json);
      const card = d.kind === 'card' && plain(stated) && stated.basis === 'stated' ? boundCard(stated.method, bindings) : null;
      if (card === null) continue;
      const cards = statedDestinations.get(orderRef) ?? [];
      if (!cards.includes(card)) cards.push(card);
      statedDestinations.set(orderRef, cards.sort(byText));
    }
  }
  return { orders, statedDestinations, chargeSnapshots, lineTies: lineTiesOf(histories) };
}
/**
 * STEP 9 integration B5 (Root): every observed line's stable tie key, by its capture-scoped item ref, per order. A ref
 * two observations give different keys (one capture read the order twice, titled differently) proves none: it is kept
 * explicitly contested (null), so a credit resting on it stays whole, never decided by whichever observation was read
 * first or last. Every observed order keeps its entry, even when all its refs are contested.
 * STEP 9 integration B5 (Root): explicit, so no absent or empty map can ever read as "no conflict".
 */
function lineTiesOf(histories: ReadonlyMap<string, readonly OrderSnapshot[]>): Map<string, Map<string, string | null>> {
  const answer = new Map<string, Map<string, string | null>>();
  for (const [orderRef, history] of histories) {
    const seen = new Map<string, string | null>();
    for (const s of history) {
      const keys = lineTieKeys(s.order);
      for (const item of s.order.items) {
        const tie = Number.isInteger(item.lineOrdinal) ? keys.get(item.lineOrdinal!) : undefined;
        if (tie === undefined) continue;
        const itemRef = opaque('line-observation', [s.captureDigest, s.order.orderId, item.lineOrdinal]);
        seen.set(itemRef, seen.has(itemRef) && seen.get(itemRef) !== tie ? null : tie);
      }
    }
    answer.set(orderRef, seen); // STEP 9 integration B5 (Root): every observed order, contested refs included
  }
  return answer;
}

/** What the credit decision is asked, from the evidence read and the whole-ledger match. */
export interface RefundCreditInputs {
  orders: RefundOrder[];
  credits: RefundCreditCandidate[];
  /** Per order, its ledger `Refunded` links: each credit's absolute amount and its card row's date. */
  existingClaims: Map<string, RefundExistingClaim[]>;
  /** Ledger `Refunded` links (final): card row -> its order, and how the matcher tied them (ledger row or native event). */
  ledgerLinks: Map<string, { orderRef: string; evidenceClass: EvidenceClass }>;
}
/** A refund the matcher itself links: a ledger `Refunded` observation or a native refund event, either way final. */
export const ledgerRefund = (s: MatchSubject | undefined): boolean => s?.provenance === 'ledger-Refunded';

/**
 * Pure assembly: in-scope credits (live posted USD credits with an itemizable Amazon descriptor), every row the matcher
 * already links, the cards of each order's linked charges and linked ledger refunds, and what those refunds claim.
 */
export function refundCreditInputs(evidence: RefundEvidence, rows: readonly LedgerRow[], subjects: readonly MatchSubject[],
  results: readonly MatchResult[]): RefundCreditInputs {
  const subjectsByRef = new Map(subjects.map(s => [s.ref, s]));
  const rowsById = new Map(rows.map(r => [r.id, r]));
  const chargeCards = new Map<string, Set<string>>(), destinationCards = new Map<string, Set<string>>();
  const existingClaims = new Map<string, RefundExistingClaim[]>(), linkedRows = new Set<string>();
  const ledgerLinks = new Map<string, { orderRef: string; evidenceClass: EvidenceClass }>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => map.set(key, (map.get(key) ?? new Set()).add(value));
  for (const result of results) {
    if (result.state !== 'linked' || !result.cardTransactionId) continue;
    const subject = subjectsByRef.get(result.subjectRef), row = rowsById.get(result.cardTransactionId);
    if (!subject || !row) continue;
    linkedRows.add(row.id);
    if (result.corroboratedBy) continue;
    if (ledgerRefund(subject)) {
      // A refund naming several orders cannot be put on one, so it counts against every order it names.
      for (const orderRef of new Set(subject.orderRefs)) {
        add(destinationCards, orderRef, row.cardAccountId);
        existingClaims.set(orderRef, [...(existingClaims.get(orderRef) ?? []), { amountMinor: Math.abs(row.amountMinor), date: row.transactionDate }]);
      }
      if (subject.orderRefs.length === 1) ledgerLinks.set(row.id, { orderRef: subject.orderRefs[0], evidenceClass: subject.evidenceClass });
    } else if (subject.money.amountMinor > 0) for (const orderRef of new Set(subject.orderRefs)) add(chargeCards, orderRef, row.cardAccountId);
  }
  for (const [orderRef, cards] of evidence.statedDestinations) for (const card of cards) add(destinationCards, orderRef, card);
  const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort(byText);
  return {
    orders: evidence.orders.map(({ total: _total, ...facts }) => ({ ...facts,
      chargeCards: sorted(chargeCards.get(facts.ref)), destinationCards: sorted(destinationCards.get(facts.ref)) })),
    credits: rows.filter(r => r.status === 'posted' && r.kind === 'refund' && minor(r.amountMinor) && r.amountMinor < 0
      && r.currency === 'USD' && amazonCardChargeKind({ description: r.description ?? '' }) === 'itemizable')
      .map(r => ({ id: r.id, cardAccountId: r.cardAccountId, date: r.transactionDate, amountMinor: -r.amountMinor,
        inScope: true, alreadyLinked: linkedRows.has(r.id) })),
    existingClaims, ledgerLinks,
  };
}

const LAG_BUCKETS = [[0, 7], [8, 14], [15, 30], [31, 45], [46, 60], [61, 90], [91, 120], [121, 180]] as const;
/**
 * Aggregate-only calibration of one policy over a database (for an operator's COPY run): outcomes by reason, linked
 * credits and their sum by proof, item attribution, and the lag histogram of linked credits. Counts and sums only:
 * no row, order, card, date or description. Reads, never writes.
 */
export function refundCreditCalibration(db: Database, policy: RefundCreditPolicy = REFUND_CREDIT_POLICY) {
  const inputs = db.transaction(() => {
    if (!hasAmazonSchema(db)) return null;
    const rows = readLedger(db), observed = readSubjects(db);
    const bindings = activeBindings(db, readCardInventory(db));
    const { results } = matchAmazon(observed, rows, bindings);
    return refundCreditInputs(readRefundEvidence(db, bindings), rows, observed, results);
  })();
  const decisions = inputs ? decideRefundCredits(inputs, policy) : new Map<string, RefundDecision>();
  const amounts = new Map(inputs?.credits.map(c => [c.id, c.amountMinor]));
  const outcomes = new Map<string, number>(), proofs = new Map<string, { count: number; sumMinor: number }>();
  const attribution = { unique: 0, held: 0 }, lags = LAG_BUCKETS.map(([from, to]) => ({ from, to, count: 0 }));
  for (const [id, decision] of decisions) {
    const key = decision.outcome === 'held' ? `held:${decision.reason}` : decision.outcome;
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    if (decision.outcome !== 'linked') continue;
    const entry = proofs.get(decision.proof) ?? { count: 0, sumMinor: 0 };
    proofs.set(decision.proof, { count: entry.count + 1, sumMinor: entry.sumMinor + amounts.get(id)! });
    attribution[decision.itemAttribution]++;
    const bucket = lags.find(b => decision.lagDays >= b.from && decision.lagDays <= b.to);
    if (bucket) bucket.count++;
  }
  return {
    policy: { ...policy }, credits: decisions.size,
    outcomes: [...outcomes].sort(([a], [b]) => byText(a, b)).map(([outcome, count]) => ({ outcome, count })),
    linkedByProof: [...proofs].sort(([a], [b]) => byText(a, b)).map(([proof, v]) => ({ proof, ...v })),
    itemAttribution: attribution, lagHistogram: lags,
  };
}
