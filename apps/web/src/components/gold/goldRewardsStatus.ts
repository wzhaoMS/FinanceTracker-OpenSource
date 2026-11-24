import {
  NO_REWARD_ANSWERS,
  estimatedRewards,
  keptUnitsCost,
  rewardPaymentKind,
  type MetalsRewardAnswers,
  type MetalsRewardFigure,
  type MetalsRewardOrder,
  type MetalsRewardPayment,
  type MetalsRewardQuestion,
} from '@finance-tracker/shared/metals-rewards';

import type { MetalsLinkedAccount, MetalsOverview, MetalsPurchase, MetalsPurchases } from './goldApi';

/*
 * The Gold page's rewards status (ROOT O101): the period's purchases read as the shared rewards math reads them. This
 * Holdr stores no rate yet, so every card and membership is a question ("rate needed"); a rate is never guessed, and no
 * figure shows until every answer it needs is given (a later PR stores the owner's answers). The figure is qualified by
 * the period's purchases (G1d's P1, ROOT O137): never a sum presented as whole while a purchase isn't counted, and never
 * "$0.00" for a period with no purchase kept or on the way.
 */

/** What each question asks the owner, in plain words (Astra's copy rulings). */
export const REWARD_QUESTION_WORDS: Record<MetalsRewardQuestion, string> = {
  'card-rate-needed': 'each card\'s cashback rate',
  'card-unknown': 'which card paid where the charge isn\'t linked',
  'refund-card-unknown': 'which original charge on the same card each refund reverses',
  'refund-exceeds-reward': 'the reward adjustment for each refund',
  'payment-not-stated': 'how some orders were paid',
  'cost-incomplete': 'the full cost assigned to each purchase',
  'shop-card-buyer-unknown': 'which card bought the Shop Card',
  'membership-rate-needed': 'each Costco membership\'s tier, and whether gold earns its reward',
  'membership-year-unknown': 'each Costco membership\'s renewal month',
  'membership-spending-unknown': 'each membership year\'s Costco spending, net of returns',
};

/** The figure's words when the period has no purchase kept or on the way, proven complete (Astra). */
export const REWARDS_NONE_KEPT = 'No purchases kept or on the way this period';
/** The same with the period's purchase records incomplete: said, never claimed none exist (Astra). */
export const REWARDS_NONE_RECORDED = 'No purchases kept or on the way are recorded for this period. Purchase records are incomplete.';
/** Beside a figure while some of the period's purchases aren't counted or lack information (Astra). */
export const REWARDS_INCOMPLETE = 'Some purchases in this period are missing information or are not counted yet.';
/** How a refund counts (the Gold lead's refund precedence; Astra's words). */
export const REWARDS_REFUND_NOTE = 'A refund reverses rewards only when it is verified against the original charge on the same card. '
  + 'The reversal uses that charge’s reward rate; otherwise, the refund’s reward adjustment remains unknown.';

/** A lot's units kept or on the way (delivered or awaiting): neither cancelled nor returned. */
const keptUnits = (purchase: MetalsPurchase) => purchase.units.delivered + purchase.units.awaiting;

/**
 * What a lot's kept units cost, by the ledger's unit split; null unless its cost is complete and not below zero (the
 * allocation can leave a line below zero, a coupon above its item's price, say: never a share of what was paid; G1d).
 */
function keptCostOf(purchase: MetalsPurchase): number | null {
  const { costMinor, units } = purchase;
  if (costMinor.state !== 'complete' || costMinor.value === null || costMinor.value < 0 || units.ordered <= 0
    || keptUnits(purchase) > units.ordered) return null;
  return keptUnitsCost(costMinor.value, units.ordered, keptUnits(purchase));
}

/** The order the page asks its questions in, whatever order the purchases come in: cards first, then Costco. */
export const REWARD_QUESTION_ORDER: readonly MetalsRewardQuestion[] = [
  'card-rate-needed', 'card-unknown', 'refund-card-unknown', 'refund-exceeds-reward', 'shop-card-buyer-unknown', 'payment-not-stated',
  'cost-incomplete', 'membership-rate-needed', 'membership-year-unknown', 'membership-spending-unknown',
];

/**
 * The period's orders, once each, as the rewards math reads them, for this metal's units kept or on the way only (a lot
 * partly returned or cancelled counts its kept units alone, at their cost by the ledger's unit split: the lead's rule 1):
 * - each payment as stated, by how it earns and, for a card charge, the card it is proof-linked to (a payment matched by
 *   its exact amount, as the source states it, to one linked charge; otherwise the card is unknown);
 * - a card refund is a negative card payment; refunds never link, so what it reverses is never proven (the order waits);
 *   so does an order whose source shows a refund its payments don't carry;
 * - a coupon tender repeats the discount the costs already carry: it pays for nothing (a discount counts once);
 * - the order's `share`: the kept units' cost over what the order's payments come to (its coupons left out), net of
 *   refunds, at most all of it. A cost not complete (partial or unknown) leaves it unknown and the order waiting
 *   (`cost-incomplete`); an amount not stated, too;
 * - a Costco order also carries its membership (the account) with the renewal month unknown, and its eligible spending for
 *   the yearly basis net of returns (the Gold lead's refund ruling, rule 6): the lesser of its kept units' cost and what
 *   the order's payments come to net of refunds, never below zero; unknown while either is, or while a refund isn't carried.
 */
export function rewardOrdersOf(read: MetalsPurchases): MetalsRewardOrder[] {
  const byOrder = new Map<string, MetalsPurchase[]>();
  for (const purchase of read.purchases) byOrder.set(purchase.orderKey, [...(byOrder.get(purchase.orderKey) ?? []), purchase]);
  const orders: MetalsRewardOrder[] = [];
  for (const [key, lots] of byOrder) {
    const keptLots = lots.filter((lot) => keptUnits(lot) > 0);
    if (keptLots.length === 0) continue;
    const first = lots[0];
    const linked = first.cards.filter((card) => card.proof && card.row !== null);
    const used = new Set<number>();
    const payments = first.funding.map((method): MetalsRewardPayment => {
      if (method.kind === 'card-refund') {
        return { kind: 'card', amountMinor: method.amountMinor === null ? null : -Math.abs(method.amountMinor), cardId: null, reverses: null };
      }
      let cardId: string | null = null;
      if (method.kind === 'card' && method.amountMinor !== null) {
        const at = linked.findIndex((card, index) => !used.has(index) && card.amountMinor === method.amountMinor);
        if (at >= 0) {
          used.add(at);
          cardId = linked[at].row!.account.id;
        }
      }
      return { kind: rewardPaymentKind(method.kind), amountMinor: method.amountMinor, cardId };
    });
    const paying = first.funding.map((method) => method.kind !== 'coupon');
    const paid = payments.some((payment, index) => paying[index] && payment.amountMinor === null)
      ? null : payments.reduce((total, payment, index) => total + (paying[index] ? payment.amountMinor ?? 0 : 0), 0);
    const costs = keptLots.map(keptCostOf);
    const keptCost = costs.some((cost) => cost === null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
    const uncarried = first.refunds.length > 0 && !first.funding.some((method) => method.kind === 'card-refund');
    const waits: MetalsRewardQuestion[] = [...(keptCost === null ? ['cost-incomplete' as const] : []), ...(uncarried ? ['refund-card-unknown' as const] : [])];
    const share = keptCost === null || paid === null || paid <= 0 ? null : { keptMinor: Math.min(keptCost, paid), paidMinor: paid };
    const eligibleMinor = keptCost === null || paid === null || uncarried ? null : Math.max(0, Math.min(keptCost, paid));
    orders.push({
      key,
      payments,
      share,
      ...(waits.length > 0 ? { waits } : {}),
      costco: first.account.source === 'costco' ? { membershipId: first.account.accountId, year: null, eligibleMinor } : null,
    });
  }
  return orders;
}

/**
 * Whether the purchases read and the overview answer the same metal and period. A read keeps its last answer while the
 * next is under way, so after a change of period one of them can still answer the period before; until both agree the
 * rewards line says nothing about the period rather than mix two periods' reads (5b01e72f's N9).
 */
export function sameRewardsPeriod(purchases: Pick<MetalsPurchases, 'metal' | 'from' | 'to'>, overview: Pick<MetalsOverview, 'metal' | 'activity'>): boolean {
  return purchases.metal === overview.metal && purchases.from === overview.activity.from && purchases.to === overview.activity.to;
}

/**
 * Whether the rewards line may speak for the period selected: both reads current (neither under way: right after a change
 * of period both still hold the period before, and a refresh can leave one older) and answering the same metal and period.
 * Otherwise it says nothing rather than a claim about the wrong period's purchases (5b01e72f's N9).
 */
export function rewardsReadsCurrent(
  purchases: Pick<MetalsPurchases, 'metal' | 'from' | 'to'>,
  overview: Pick<MetalsOverview, 'metal' | 'activity'>,
  busy: { purchases: boolean; overview: boolean },
): boolean {
  return !busy.purchases && !busy.overview && sameRewardsPeriod(purchases, overview);
}

/**
 * Whether the period's purchases are all counted, as the overview reads them: what was bought (kept or on the way) in the
 * period is complete. Bought's cost carries the period's own holds (`source-held`: buy-side holds dated in the period, and
 * undated open ones), so an order held for an answer at another date doesn't withhold the period's figure: `needsAnswer`
 * lists every held order whatever its date (5b01e72f, PR-R). A Costco membership year's pool is another question: a
 * complete period doesn't make its year's allocation complete (a held order elsewhere in the year can still change it).
 */
export function periodPurchasesComplete(overview: Pick<MetalsOverview, 'activity'>): boolean {
  return overview.activity.bought.costMinor.state === 'complete';
}

/**
 * The figure as the page says it: `none` (no purchase kept or on the way, the period's purchases complete: words, never
 * "$0.00"), `unknown` (no usable figure, or none kept while the purchases aren't complete), `partial` (a known sum while
 * some of the period's purchases aren't counted) or `complete`.
 */
export type GoldRewardsState = 'complete' | 'partial' | 'unknown' | 'none';

export interface GoldRewardsStatus {
  figure: MetalsRewardFigure;
  state: GoldRewardsState;
  /** The period's orders with a unit kept or on the way. */
  orders: number;
  /** Some of the period's purchases aren't counted or lack information. */
  incomplete: boolean;
  /** The questions the estimate waits for, in plain words, each once, in REWARD_QUESTION_ORDER. */
  needs: string[];
  /** Paying cards proven linked, most charged first: each charge the estimate matched to its card, summed per card, each order counted once per card. Each needs its own rate (never one rate for a network). */
  cards: Array<{ account: MetalsLinkedAccount; orders: number; chargedMinor: number }>;
  /** Orders with a card charge matched to no linked charge, by network: each order once per network. */
  unlinked: Array<{ network: string; orders: number }>;
  costcoMemberships: Array<{ accountId: string; label: string; orders: number }>;
  shopCardOrders: number;
}

/**
 * The period's rewards status: the estimate (unknown until every answer is given), how it is said, and what it waits
 * for. `complete` says whether the period's purchases are all counted (periodPurchasesComplete); unsaid, they aren't. A
 * Costco order's share of its membership year is allocated over the whole year's orders (`yearOrders` in the shared
 * math); the page knows no membership's renewal month yet (every share waits for `membership-year-unknown`), so the
 * period's orders are passed alone. The PR that stores the owner's answers passes every metal's orders of each membership
 * year, and keeps a year's pool unknown while any of its orders is held, whatever the period shown (5b01e72f).
 */
export function rewardsStatus(read: MetalsPurchases, answers: MetalsRewardAnswers = NO_REWARD_ANSWERS, complete = false): GoldRewardsStatus {
  const orders = rewardOrdersOf(read);
  const figure = estimatedRewards(orders, answers);
  const state: GoldRewardsState = orders.length === 0
    ? (complete ? 'none' : 'unknown')
    : figure.minor === null ? 'unknown' : complete ? 'complete' : 'partial';
  const firstOf = new Map<string, MetalsPurchase>();
  for (const purchase of read.purchases) if (!firstOf.has(purchase.orderKey)) firstOf.set(purchase.orderKey, purchase);
  const cards = new Map<string, { account: MetalsLinkedAccount; orders: number; chargedMinor: number }>();
  const unlinked = new Map<string, number>();
  const memberships = new Map<string, { accountId: string; label: string; orders: number }>();
  let shopCardOrders = 0;
  for (const order of orders) {
    const purchase = firstOf.get(order.key)!;
    // The order's charges as the estimate reads them, refunds aside: a charge matched to its proof-linked card adds to that
    // card, the order counted once per card; a linked charge no stated payment matched pays for nothing here (the estimate
    // calls that payment's card unknown); a charge matched to no linked one is an unknown card, the order once per network.
    const accounts = new Map<string, MetalsLinkedAccount>();
    for (const card of purchase.cards) if (card.proof && card.row !== null) accounts.set(card.row.account.id, card.row.account);
    const cardsHere = new Set<string>();
    const networksHere = new Set<string>();
    order.payments.forEach((payment, index) => {
      if (payment.kind !== 'card' || purchase.funding[index]?.kind !== 'card') return;
      if (payment.cardId === null) {
        networksHere.add(purchase.funding[index]?.network ?? 'unknown');
        return;
      }
      const entry = cards.get(payment.cardId) ?? { account: accounts.get(payment.cardId)!, orders: 0, chargedMinor: 0 };
      if (!cardsHere.has(payment.cardId)) entry.orders += 1;
      cardsHere.add(payment.cardId);
      entry.chargedMinor += payment.amountMinor!;
      cards.set(payment.cardId, entry);
    });
    for (const network of networksHere) unlinked.set(network, (unlinked.get(network) ?? 0) + 1);
    if (order.payments.some((payment) => payment.kind === 'shop-card')) shopCardOrders += 1;
    if (order.costco) {
      const entry = memberships.get(order.costco.membershipId) ?? { accountId: order.costco.membershipId, label: purchase.account.label, orders: 0 };
      entry.orders += 1;
      memberships.set(order.costco.membershipId, entry);
    }
  }
  return {
    figure,
    state,
    orders: orders.length,
    incomplete: !complete,
    needs: REWARD_QUESTION_ORDER.filter((question) => figure.questions.includes(question)).map((question) => REWARD_QUESTION_WORDS[question]),
    cards: [...cards.values()].sort((a, b) => b.chargedMinor - a.chargedMinor || a.account.name.localeCompare(b.account.name)),
    unlinked: [...unlinked.entries()].map(([network, count]) => ({ network, orders: count })).sort((a, b) => b.orders - a.orders),
    costcoMemberships: [...memberships.values()].sort((a, b) => a.label.localeCompare(b.label)),
    shopCardOrders,
  };
}
