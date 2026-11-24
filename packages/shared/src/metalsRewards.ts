/**
 * Rewards on precious-metals purchases: pure arithmetic over the owner's own answers (ROOT O101; the numbers review is
 * 5b01e72f's). A rate is an answer the owner gives per card (never one rate for every card of a network) or per
 * membership. An unknown answer is a question, never a guess: every figure it reaches is unknown (null) and says which
 * question it waits for. Amounts are integer cents; rates are integer basis points (1.5% is 150).
 *
 * - A card charge earns its card's rate on its part of the order (the order's `share`: what bought the units counted, over
 *   what the order's payments came to), net of the refunds proven to reverse it, rounded once per charge.
 * - A refund (a negative card payment) reverses only when it is proven tied to its charge on that charge's own card
 *   (`reverses`), and then at that charge's rate, never the rate of a card it went to: a charge refunded in full earns
 *   exactly nothing, however its refunds were split. A refund not proven so leaves its order's rewards unknown
 *   (`refund-card-unknown`), and one that takes back more than its charge too (`refund-exceeds-reward`): the Gold lead's
 *   refund precedence, 1 to 3.
 * - A payment by Shop Card earns the rate of the card that bought the Shop Card (ROOT's default).
 * - A Costco order may also earn its membership's Executive reward: the rate on ALL the membership's eligible Costco
 *   spending in a membership year (net of returns), capped per membership year. The metals' share of that year's capped
 *   reward is proportional to their eligible spending in it (ROOT's default), split exactly over every metal order of the
 *   year, so an order's share never changes with the period displayed.
 * - Estimated rewards are their own line. A return including rewards adds them on a matched basis: a sale's profit gains
 *   the rewards of the purchase units it sold (earliest units first, as its cost), and holdings those of the units still
 *   held. Only a lot's kept units count (neither cancelled nor returned, whatever the rates: the lead's rule 1): the
 *   ledger numbers a lot's units delivered first, then awaiting, then returned, then cancelled, and splits its cost over
 *   them by largest remainder, earlier units first, so its kept units are its first ones (`keptUnitsCost`). A lot's
 *   reward cents belong to its kept units the same way, so its uses always add up to its whole reward.
 * - A sum is known only when every part is: one unknown part leaves it unknown, whether or not that part says why.
 * - An order never earns less than nothing: a figure below zero reads unknown, saying why, never a negative figure and
 *   never a silent zero (the Gold lead's refund ruling, rule 1).
 */

import { metalsUnitSplit } from './metalsLedger/allocation.js';

/** What an estimate waits for, said plainly by the page. */
export type MetalsRewardQuestion =
  | 'card-rate-needed'
  | 'card-unknown'
  | 'refund-card-unknown'
  | 'refund-exceeds-reward'
  | 'payment-not-stated'
  | 'cost-incomplete'
  | 'shop-card-buyer-unknown'
  | 'membership-rate-needed'
  | 'membership-year-unknown'
  | 'membership-spending-unknown';

/** How a payment can earn: by a card, by a Shop Card (through the card that bought it), never, or not known. */
export type MetalsRewardPaymentKind = 'card' | 'shop-card' | 'no-reward' | 'not-stated';

export interface MetalsRewardPayment {
  kind: MetalsRewardPaymentKind;
  /** The amount paid this way (negative for a card refund); null when the source doesn't state it. */
  amountMinor: number | null;
  /**
   * The card that earns: the paying card (a card account id), the card a refund went back to, or for a Shop Card the card
   * that bought it; null when unknown.
   */
  cardId: string | null;
  /**
   * A refund only: the index, in its order's payments, of the card charge it is proven to reverse; null or absent when no
   * proof ties it to one. It reverses only a charge on its own card.
   */
  reverses?: number | null;
}

/** The part of an order's payments that bought what is counted: `keptMinor` over `paidMinor`, at most all of it. */
export interface MetalsRewardShare {
  keptMinor: number;
  paidMinor: number;
}

export interface MetalsRewardOrder {
  key: string;
  /** As stated, never scaled: each card charge counts at `share`, once, net of its proven refunds. */
  payments: MetalsRewardPayment[];
  /** Absent: all of the payments count. Null: the part can't be told, so the rewards wait (`waits` or a payment says why). */
  share?: MetalsRewardShare | null;
  /** What the order's rewards wait for beyond its payments' own questions: a cost not complete, a refund its payments don't carry. */
  waits?: MetalsRewardQuestion[];
  /**
   * A Costco order: its membership, the membership year it falls in (null while the renewal month isn't known), and its
   * spending that counts toward the Executive reward (null when unknown).
   */
  costco: { membershipId: string; year: string | null; eligibleMinor: number | null } | null;
}

export interface MetalsMembershipAnswer {
  /** The Executive reward's rate, in basis points. */
  basisPoints: number;
  /** Whether purchases of precious metals earn it. */
  metalsEligible: boolean;
  /** The most it pays per membership year, in cents. */
  capMinor: number;
}

export interface MetalsRewardAnswers {
  /** The owner's rate per card account id, in basis points; a card absent here needs its rate. */
  cardRates: ReadonlyMap<string, number>;
  /** The owner's answer per membership id; a membership absent here needs its answer (tier, rate and eligibility). */
  memberships: ReadonlyMap<string, MetalsMembershipAnswer>;
  /** ALL eligible Costco spending of a membership in a membership year, keyed `membershipYearKey(id, year)`; absent: unknown. */
  membershipYearSpendMinor: ReadonlyMap<string, number>;
}

/** No answers at all: what a Holdr with no stored rates has. */
export const NO_REWARD_ANSWERS: MetalsRewardAnswers = { cardRates: new Map(), memberships: new Map(), membershipYearSpendMinor: new Map() };

/** A figure in cents, or null with the questions it waits for (each once, in the order met). */
export interface MetalsRewardFigure {
  minor: number | null;
  questions: MetalsRewardQuestion[];
}

export const membershipYearKey = (membershipId: string, year: string) => `${membershipId}|${year}`;

/** A rate on an amount, rounded to the cent (half away from zero). */
export function rewardOn(amountMinor: number, basisPoints: number): number {
  const exact = (amountMinor * basisPoints) / 10_000;
  return Math.sign(exact) * Math.round(Math.abs(exact));
}

const figure = (minor: number, questions: MetalsRewardQuestion[]): MetalsRewardFigure =>
  ({ minor: questions.length > 0 ? null : minor, questions: [...new Set(questions)] });

/** Sums figures: known only when every part is (an unknown part says why or not, the sum is unknown). */
export function sumRewardFigures(parts: readonly MetalsRewardFigure[]): MetalsRewardFigure {
  const questions = [...new Set(parts.flatMap((part) => part.questions))];
  if (questions.length > 0 || parts.some((part) => part.minor === null)) return { minor: null, questions };
  return { minor: parts.reduce((total, part) => total + part.minor!, 0), questions };
}

/** num / den (den > 0) rounded to the integer, half away from zero, exactly. */
function roundRatio(num: bigint, den: bigint): number {
  const negative = num < 0n;
  const magnitude = negative ? -num : num;
  const whole = magnitude / den;
  const rounded = 2n * (magnitude % den) >= den ? whole + 1n : whole;
  return Number(negative ? -rounded : rounded);
}

/** A rate on an amount's counted part (`share`; absent: all of it), rounded once to the cent, in exact integers. */
function rewardOnShare(amountMinor: number, basisPoints: number, share: MetalsRewardShare | undefined): number {
  if (share === undefined) return rewardOn(amountMinor, basisPoints);
  const kept = Math.min(share.keptMinor, share.paidMinor);
  return roundRatio(BigInt(amountMinor) * BigInt(basisPoints) * BigInt(kept), 10_000n * BigInt(share.paidMinor));
}

/**
 * The card rewards an order's payments earn: each card charge and each Shop Card payment at its card's rate, on its part
 * of the order (`share`), the charge net of the refunds proven to reverse it, rounded once. A refund reverses only a
 * charge on its own card that it is proven tied to, at that charge's rate.
 */
export function orderCardReward(order: MetalsRewardOrder, answers: MetalsRewardAnswers): MetalsRewardFigure {
  const share = order.share;
  if (share !== undefined && share !== null
    && (!Number.isSafeInteger(share.keptMinor) || !Number.isSafeInteger(share.paidMinor) || share.keptMinor < 0 || share.paidMinor <= 0)) {
    throw new RangeError(`orderCardReward: order ${order.key}'s share ${share.keptMinor}/${share.paidMinor} is not a part of what it paid`);
  }
  const questions: MetalsRewardQuestion[] = [...(order.waits ?? [])];
  const charges = new Map<number, { cardId: string; amountMinor: number; refundedMinor: number }>();
  const earning: Array<{ cardId: string; amountMinor: number }> = [];
  const refunds: MetalsRewardPayment[] = [];
  order.payments.forEach((payment, index) => {
    if (payment.kind === 'no-reward') return;
    if (payment.kind === 'not-stated' || payment.amountMinor === null) {
      questions.push('payment-not-stated');
      return;
    }
    if (payment.amountMinor < 0) {
      refunds.push(payment);
      return;
    }
    if (payment.cardId === null) {
      questions.push(payment.kind === 'shop-card' ? 'shop-card-buyer-unknown' : 'card-unknown');
      return;
    }
    if (payment.kind === 'card') charges.set(index, { cardId: payment.cardId, amountMinor: payment.amountMinor, refundedMinor: 0 });
    else earning.push({ cardId: payment.cardId, amountMinor: payment.amountMinor });
  });
  for (const refund of refunds) {
    const charge = refund.reverses === undefined || refund.reverses === null ? undefined : charges.get(refund.reverses);
    if (refund.kind !== 'card' || charge === undefined || refund.cardId !== charge.cardId) {
      questions.push('refund-card-unknown');
      continue;
    }
    charge.refundedMinor -= refund.amountMinor!;
    if (charge.refundedMinor > charge.amountMinor) questions.push('refund-exceeds-reward');
  }
  // A charge refunded in full, or any payment of nothing, earns nothing whatever its rate (the lead's rule 1): only what
  // is left asks for a rate, and only it needs the order's part to be known.
  const nets = [...charges.values()].map(({ cardId, amountMinor, refundedMinor }) => ({ cardId, amountMinor: amountMinor - refundedMinor }))
    .concat(earning).filter((payment) => payment.amountMinor !== 0);
  if (order.payments.length === 0 || (share === null && questions.length === 0 && nets.length > 0)) questions.push('payment-not-stated');
  let minor = 0;
  for (const charge of nets) {
    const rate = answers.cardRates.get(charge.cardId);
    if (rate === undefined) {
      questions.push('card-rate-needed');
      continue;
    }
    if (share !== null) minor += rewardOnShare(charge.amountMinor, rate, share);
  }
  return figure(minor, questions);
}

/**
 * Splits `total` cents over `weights` in proportion, exactly (largest remainder; ties to the earlier weight), so the
 * parts always add up to the total.
 */
export function splitProportionally(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const parts = exact.map((value) => Math.floor(value));
  let left = total - parts.reduce((acc, part) => acc + part, 0);
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let at = 0; left > 0 && at < order.length; at += 1, left -= 1) parts[order[at].index] += 1;
  return parts;
}

/**
 * Each Costco order's share of its membership year's capped Executive reward, fixed by the year's data alone: the year's
 * reward is the rate on ALL the membership's eligible spending that year, capped; the metals' share of it is proportional
 * to their eligible spending, and is split exactly over EVERY metal order of that membership year (largest remainder,
 * ties to the lower order key). So an order's share never changes with the period shown, and a year's shares add up to
 * the metals' share exactly. `yearOrders` are the orders the shares are allocated over (every metal's, the whole
 * membership year; `orders` themselves when omitted); each of `orders` (a period's) takes its fixed share from that. One
 * order of a year whose eligible spending isn't known leaves every share of that year unknown. A non-Costco order has
 * no entry.
 */
export function costcoRewardShares(
  orders: readonly MetalsRewardOrder[],
  answers: MetalsRewardAnswers,
  yearOrders: readonly MetalsRewardOrder[] = orders,
): Map<string, MetalsRewardFigure> {
  const shares = new Map<string, MetalsRewardFigure>();
  const pool = new Map<string, MetalsRewardOrder>();
  for (const order of [...yearOrders, ...orders]) if (!pool.has(order.key)) pool.set(order.key, order);
  const years = new Map<string, MetalsRewardOrder[]>();
  for (const order of pool.values()) {
    if (!order.costco) continue;
    // Nothing eligible spent: no part of any year's reward, whatever the answers (a weight of zero in the year's split).
    if (order.costco.eligibleMinor === 0) { shares.set(order.key, figure(0, [])); continue; }
    const answer = answers.memberships.get(order.costco.membershipId);
    if (!answer) { shares.set(order.key, figure(0, ['membership-rate-needed'])); continue; }
    if (!answer.metalsEligible) { shares.set(order.key, figure(0, [])); continue; }
    if (order.costco.year === null) { shares.set(order.key, figure(0, ['membership-year-unknown'])); continue; }
    const key = membershipYearKey(order.costco.membershipId, order.costco.year);
    years.set(key, [...(years.get(key) ?? []), order]);
  }
  for (const [key, list] of years) {
    const answer = answers.memberships.get(list[0].costco!.membershipId)!;
    const yearSpend = answers.membershipYearSpendMinor.get(key);
    const unknownSpend = list.some((order) => order.costco!.eligibleMinor === null);
    const metalsSpend = list.reduce((total, order) => total + (order.costco!.eligibleMinor ?? 0), 0);
    // The year's spending includes the metals; less than them (or none known) can't be a basis, nor can a year with one
    // of its metal orders' spending unknown. A known zero (a year refunded in full, say) earns a known zero.
    if (unknownSpend || yearSpend === undefined || yearSpend < metalsSpend || yearSpend < 0) {
      for (const order of list) shares.set(order.key, figure(0, ['membership-spending-unknown']));
      continue;
    }
    const yearReward = Math.min(rewardOn(yearSpend, answer.basisPoints), answer.capMinor);
    const metalsShare = splitProportionally(yearReward, [metalsSpend, yearSpend - metalsSpend])[0];
    const byKey = [...list].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const parts = splitProportionally(metalsShare, byKey.map((order) => order.costco!.eligibleMinor!));
    byKey.forEach((order, index) => shares.set(order.key, figure(parts[index], [])));
  }
  const asked = new Set(orders.map((order) => order.key));
  return new Map([...shares].filter(([orderKey]) => asked.has(orderKey)));
}

/**
 * Each order's estimated rewards: its card rewards and, for Costco, its fixed share of the membership year's reward
 * (allocated over `yearOrders`, see costcoRewardShares). An order whose rewards would come to less than nothing is
 * unknown, with `refund-exceeds-reward`.
 */
export function orderRewards(
  orders: readonly MetalsRewardOrder[],
  answers: MetalsRewardAnswers,
  yearOrders: readonly MetalsRewardOrder[] = orders,
): Map<string, MetalsRewardFigure> {
  const costco = costcoRewardShares(orders, answers, yearOrders);
  return new Map(orders.map((order) => {
    const reward = sumRewardFigures([orderCardReward(order, answers), costco.get(order.key) ?? figure(0, [])]);
    return [order.key, reward.minor !== null && reward.minor < 0 ? figure(0, ['refund-exceeds-reward']) : reward];
  }));
}

/** Estimated rewards over orders: their own line, never part of a market gain or loss. */
export function estimatedRewards(
  orders: readonly MetalsRewardOrder[],
  answers: MetalsRewardAnswers,
  yearOrders: readonly MetalsRewardOrder[] = orders,
): MetalsRewardFigure {
  return sumRewardFigures([...orderRewards(orders, answers, yearOrders).values()]);
}

/** A purchase lot: its order, its kept units' cost (the reward's share within the order) and its kept units. */
export interface MetalsRewardLot {
  key: string;
  orderKey: string;
  /** What its kept units cost (`keptUnitsCost`); null when unknown. */
  costMinor: number | null;
  /** Its kept units: neither cancelled nor returned (numbered first, so a sale's or a holding's unit indexes are theirs). */
  units: number;
}

/**
 * What a lot's kept units cost: the ledger splits a lot's cost over its ordered units by largest remainder, earlier units
 * first (metalsUnitSplit), and numbers them delivered first, then awaiting, then returned, then cancelled, so its kept
 * units (delivered or awaiting) are its first `kept`. A count outside the lot is a caller's error (a RangeError).
 */
export function keptUnitsCost(costMinor: number, ordered: number, kept: number): number {
  if (!Number.isSafeInteger(ordered) || !Number.isSafeInteger(kept) || ordered <= 0 || kept < 0 || kept > ordered) {
    throw new RangeError(`keptUnitsCost: ${kept} kept units of ${ordered} ordered`);
  }
  if (kept === ordered) return costMinor;
  return metalsUnitSplit(costMinor, ordered).slice(0, kept).reduce((total, cents) => total + cents, 0);
}

/** Each lot's share of its order's rewards, in proportion to its kept units' cost within the order (exactly). */
export function lotRewards(lots: readonly MetalsRewardLot[], rewards: ReadonlyMap<string, MetalsRewardFigure>): Map<string, MetalsRewardFigure> {
  const out = new Map<string, MetalsRewardFigure>();
  const byOrder = new Map<string, MetalsRewardLot[]>();
  for (const lot of lots) byOrder.set(lot.orderKey, [...(byOrder.get(lot.orderKey) ?? []), lot]);
  for (const [orderKey, list] of byOrder) {
    const reward = rewards.get(orderKey) ?? figure(0, ['payment-not-stated']);
    if (reward.minor === null || list.some((lot) => lot.costMinor === null)) {
      // A known reward whose lots' costs aren't all known can't be shared out: what it waits for is the cost.
      const questions = reward.questions.length > 0 ? reward.questions : ['cost-incomplete' as const];
      for (const lot of list) out.set(lot.key, figure(0, questions));
      continue;
    }
    const parts = splitProportionally(reward.minor, list.map((lot) => lot.costMinor ?? 0));
    list.forEach((lot, index) => out.set(lot.key, figure(parts[index], [])));
  }
  return out;
}

/**
 * The rewards of a lot's units [fromUnit, fromUnit + units), counted earliest first: the lot's reward cents belong to its
 * units by largest remainder, earlier units first (metalsUnitSplit, as the ledger splits costs and nets), so a lot's
 * uses always add up to its whole reward, however its sales are split into cycles. Units outside the lot are a caller's
 * error (a RangeError), never a guessed figure.
 */
function unitsReward(lot: MetalsRewardLot | undefined, reward: MetalsRewardFigure | undefined, fromUnit: number, units: number): MetalsRewardFigure {
  if (!lot || !reward) return figure(0, ['payment-not-stated']);
  if (!Number.isSafeInteger(fromUnit) || !Number.isSafeInteger(units) || fromUnit < 0 || units < 0 || fromUnit + units > lot.units) {
    throw new RangeError(`withMatchedRewards: units ${fromUnit} to ${fromUnit + units} are outside lot ${lot.key}'s ${lot.units}`);
  }
  if (reward.minor === null) return reward;
  if (units === 0) return figure(0, []);
  const perUnit = metalsUnitSplit(reward.minor, lot.units);
  return figure(perUnit.slice(fromUnit, fromUnit + units).reduce((total, cents) => total + cents, 0), []);
}

/**
 * A matched return including rewards: a figure (a sale's profit or holdings' gain, in cents; null when unknown) plus the
 * rewards of the exact purchase units behind it: for sales, each cycle's sold units of a lot, from the unit where that
 * cycle's units start (the lot's units counted earliest first, as sales take them); for holdings, each lot's units still
 * held, from the first unit not sold.
 */
export function withMatchedRewards(
  base: number | null,
  units: ReadonlyArray<{ lotKey: string; fromUnit: number; units: number }>,
  lots: ReadonlyMap<string, MetalsRewardLot>,
  rewards: ReadonlyMap<string, MetalsRewardFigure>,
): MetalsRewardFigure {
  const parts = units.map((entry) => unitsReward(lots.get(entry.lotKey), rewards.get(entry.lotKey), entry.fromUnit, entry.units));
  const total = sumRewardFigures(parts);
  if (base === null || total.minor === null) return { minor: null, questions: total.questions };
  return { minor: base + total.minor, questions: [] };
}

/** The tenders that never earn: cash, gift cards, store balance, reward certificates and coupons. */
const NO_REWARD_TENDERS: ReadonlySet<string> = new Set(['cash', 'gift-card', 'store-balance', 'reward-certificate', 'coupon']);

/**
 * How a tender earns, as this module counts it: a card (a card refund too, as a negative payment) or a Shop Card by their
 * card; cash, gift cards, store balance, certificates and coupons earn nothing. Any other tender is a question, PayPal's
 * funding and a debit card's terms included (neither is stated), and so is one this module doesn't know: never assumed
 * to earn nothing (fail closed; G1d).
 */
export function rewardPaymentKind(tender: string): MetalsRewardPaymentKind {
  if (tender === 'card' || tender === 'card-refund') return 'card';
  if (tender === 'shop-card') return 'shop-card';
  return NO_REWARD_TENDERS.has(tender) ? 'no-reward' : 'not-stated';
}
