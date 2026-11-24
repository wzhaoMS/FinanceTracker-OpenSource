import { OWNER_LABELS, amazonPartLabel, amazonWholeRowReasonText, formatMinor } from '../spending/spendingFormat';
import type {
  AmazonBeneficiary,
  AmazonCardNetwork,
  AmazonCoverageFamily,
  AmazonHeldReason,
  AmazonItem,
  AmazonMatch,
  AmazonMoney,
  AmazonPaymentMethod,
  AmazonPurchaseChannel,
  AmazonRefund,
  AmazonRefundDestination,
  AmazonRefundStatus,
  AmazonSpending,
  AmazonSpendingCategorySource,
  AmazonSpendingTotals,
  AmazonSpendingWindow,
  AmazonSummary,
  AmazonSummaryLine,
  AmazonSummaryLineKind,
  AmazonTenderCoverage,
} from './amazonApi';

/**
 * Display words for the Amazon area. Every label names what the API reported, and nothing it did not. Where a card
 * charge's Amazon order in Spending says the same thing (how it was tied, who chose an item's category, an ambiguous
 * hold), the words are Spending's own helpers (spendingFormat.ts), so both views read alike.
 */

export const BENEFICIARY_LABELS: Record<AmazonBeneficiary, string> = { ...OWNER_LABELS, unknown: 'Unknown' };

/** Where an order was bought, when it wasn't on Amazon itself: a Whole Foods store's receipt, never an Amazon Fresh delivery. */
export function purchaseChannelText(channel: AmazonPurchaseChannel | undefined): string | null {
  return channel === 'whole-foods-in-store' ? 'Whole Foods (in store)' : null;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export function formatMoney(money: AmazonMoney): string {
  return formatMinor(money.amountMinor, money.currency);
}

/**
 * Why an order's match is held, as its page's "Why?" says it after "Needs review:". The first three hold an order before
 * any card charge is its candidate, so no card charge ever shows them; the last, that the Amazon payment ledger's entry
 * for the order pays for other orders too, so no card charge is this order's alone.
 */
const HELD_WORDS: Record<Exclude<AmazonHeldReason, 'ambiguous'>, string> = {
  'binding-held': 'its payment method isn\'t bound to a Holdr card',
  'evidence-held': 'there isn\'t enough payment evidence to match it',
  'no-candidate': 'no card charge matches it',
  'multiple-orders': 'its payment covers more than one order',
};

/**
 * An ambiguous order (its candidates aren't one-to-one with card charges, either way) is exactly what holds each of
 * its candidate charges as `match-held` in Spending, so it takes Spending's words for that hold.
 */
export function heldReasonText(reason: AmazonHeldReason): string {
  return reason === 'ambiguous' ? amazonWholeRowReasonText('match-held') : HELD_WORDS[reason];
}

export function candidateText(count: number): string {
  return plural(count, 'candidate card charge');
}

export type AmazonLinkedMatch = Extract<AmazonMatch, { state: 'linked' }>;

/**
 * An order's card match as one plain line, on its card and its page: linked, needs review (any match held), none, or
 * not reported (never "none" from a gap), with the card transactions linked (each once), which the line lets you open.
 * A linked transaction may be the order's charge or a refund credit (the answer doesn't say which), so the line says
 * "card transaction", as the Card transactions tab does. Why a match is held, and how a linked one was tied, stay on
 * the order's page.
 */
export function orderMatchStatus(matches: readonly AmazonMatch[] | undefined): {
  status: 'linked' | 'review' | 'none' | 'unreported';
  text: string;
  linked: AmazonLinkedMatch[];
} {
  if (matches === undefined) return { status: 'unreported', text: 'Card match not reported', linked: [] };
  if (matches.length === 0) return { status: 'none', text: 'No card match', linked: [] };
  const linked: AmazonLinkedMatch[] = [];
  for (const match of matches) {
    if (match.state === 'linked' && !linked.some((seen) => seen.cardTransactionId === match.cardTransactionId)) linked.push(match);
  }
  if (matches.some((match) => match.state === 'held')) return { status: 'review', text: 'Card match needs review', linked };
  return {
    status: 'linked',
    text: linked.length === 1 ? 'Linked to a card transaction' : `Linked to ${plural(linked.length, 'card transaction')}`,
    linked,
  };
}

/**
 * The summary's card matches, as the API counts them: Amazon payment records matched against card transactions (not
 * orders: an order can have several), how many are linked, and how many need review.
 */
export function cardMatchFigure(linked: number, held: number): { value: string; note: string } {
  return {
    value: `${linked.toLocaleString('en-US')} linked`,
    note: held === 0 ? 'none need review' : `${held.toLocaleString('en-US')} ${held === 1 ? 'needs' : 'need'} review`,
  };
}

/** Refund observations as the summary counts them: each time one was seen, so never a count of unique refunds. */
export function refundObservationNote(issued: number): string {
  return `${issued.toLocaleString('en-US')} issued · a refund seen twice counts twice`;
}

/** The counts behind the summary's figures, under "How this was counted": each one in words, none of them guessed. */
export function summaryCountedLines(summary: Pick<AmazonSummary, 'paymentObservations' | 'unknownBeneficiary' | 'itemized'>): string[] {
  const count = (value: number) => value.toLocaleString('en-US');
  return [
    `Payment records observed: ${count(summary.paymentObservations)}`,
    // Only from an API that counts them: never a guessed 0.
    ...(summary.itemized
      ? [`Card charges itemized in Spending: ${count(summary.itemized.rows)}, in ${plural(summary.itemized.parts, 'item part')}`] : []),
    `Orders not assigned to anyone (For: Unknown): ${count(summary.unknownBeneficiary)}`,
  ];
}

/** An order's refunds on its page: how many were observed, none, or not reported (never "none" from a gap). */
export function refundCountText(refunds: readonly AmazonRefund[] | undefined): string {
  if (refunds === undefined) return 'Not reported';
  return refunds.length === 0 ? 'None observed' : refunds.length.toLocaleString('en-US');
}

const COVERAGE_FAMILIES: readonly AmazonCoverageFamily[] = ['orders', 'details', 'payments', 'refunds'];

/**
 * The limit beside the summary's figures, in view while how they were counted is folded: they count imported records
 * only, and unless the latest capture reports every family complete (or there is none to say), the order history may
 * be incomplete.
 */
export function summaryLimit(coverage: AmazonSummary['latestCoverage']): { text: string; complete: boolean } {
  const complete = coverage !== null && COVERAGE_FAMILIES.every((family) => coverage[family]?.status === 'complete');
  return { text: complete ? 'Imported records only.' : 'Imported records only; order history may be incomplete.', complete };
}

/** One entry of an order's card match as shown: a match and how many of the order's matches it stands for. */
export interface AmazonMatchGroup {
  match: AmazonMatch;
  count: number;
}

/**
 * An order's matches as the page lists them: held matches with the same reason and candidate count become one entry
 * with how many there were (an order can carry several, word for word alike), in the order the first of each came;
 * a linked match is its own card charge and always stays its own entry.
 */
export function groupMatches(matches: readonly AmazonMatch[]): AmazonMatchGroup[] {
  const groups: AmazonMatchGroup[] = [];
  const held = new Map<string, AmazonMatchGroup>();
  for (const match of matches) {
    if (match.state !== 'held') {
      groups.push({ match, count: 1 });
      continue;
    }
    const key = `${match.reason}:${match.candidateCount}`;
    const group = held.get(key);
    if (group) {
      group.count += 1;
    } else {
      const entry = { match, count: 1 };
      held.set(key, entry);
      groups.push(entry);
    }
  }
  return groups;
}

/**
 * The category an item counts under in this view, and who chose it, in Spending's words for a card charge's items
 * (amazonPartLabel). Precedence is the API's: yours, the agent's, a mapping. An Amazon Fresh line's is its item
 * category's card category, or, while nothing classifies it, Groceries' as a default, said so.
 */
export function itemCategory(item: Pick<AmazonItem, 'category' | 'confidence'> & { categorySource: AmazonSpendingCategorySource | null }): {
  name: string;
  /** Who chose it, as a phrase ("classified from its title, 92% sure"); empty without a category. */
  source: string;
  tone: 'user' | 'agent' | 'mapping' | 'uncategorized' | 'unreported';
} {
  if (item.category === undefined) return { name: 'Category not reported', source: '', tone: 'unreported' };
  if (item.category === null) return { name: 'Uncategorized', source: '', tone: 'uncategorized' };
  if (item.categorySource === null) return { name: item.category, source: 'source not reported', tone: 'unreported' };
  if (item.categorySource === 'item-taxonomy') return { name: item.category, source: 'from its item category', tone: 'mapping' };
  if (item.categorySource === 'fresh-default') {
    return { name: item.category, source: 'Amazon Fresh default until it is classified', tone: 'uncategorized' };
  }
  const confidence = item.categorySource === 'agent-classification' && item.confidence !== null
    ? `, ${Math.round(item.confidence * 100)}% sure` : '';
  const tone = item.categorySource === 'item-override' ? 'user' : item.categorySource === 'agent-classification' ? 'agent' : 'mapping';
  // An observed item is no share of a charge's tax or shipping: it reads as a part that is the item's own price.
  const source = amazonPartLabel({ classification: 'source', categorySource: item.categorySource });
  return { name: item.category, source: `${source}${confidence}`, tone };
}

const TENDERS: Record<AmazonTenderCoverage, string> = {
  'single-card-proven': 'Paid by one card (proven)',
  'multi-tender': 'Split payment',
  unknown: 'Payment split not proven',
};

export function tenderText(coverage: AmazonTenderCoverage): string {
  return TENDERS[coverage];
}

const REFUND_STATUS: Record<AmazonRefundStatus, string> = {
  issued: 'Refund issued',
  pending: 'Refund pending',
  unknown: 'Refund, status unknown',
};

const DESTINATIONS: Record<AmazonRefundDestination, string> = {
  card: 'to the card',
  balance: 'to the Amazon balance',
  points: 'to points',
  unknown: 'destination unknown',
};

/** "Refund issued · $12.00 · to the card": the amount only when the API reports it, as a positive refund. */
export function refundText(refund: AmazonRefund): string {
  return [
    REFUND_STATUS[refund.status],
    refund.amount ? formatMoney({ ...refund.amount, amountMinor: Math.abs(refund.amount.amountMinor) }) : 'amount not reported',
    DESTINATIONS[refund.destination],
  ].join(' · ');
}

const NETWORKS: Record<AmazonCardNetwork, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', unknown: 'Card',
};

export function paymentMethodText(method: AmazonPaymentMethod): string {
  if (method.kind === 'card') return method.last4 ? `${NETWORKS[method.network]} ··${method.last4}` : `${NETWORKS[method.network]} (ending not captured)`;
  if (method.kind === 'balance') return 'Amazon balance';
  if (method.kind === 'points') return 'Points';
  return 'Unknown payment method';
}

/** Gift card, balance and points lines: they pay for an order without a card charge, so they are never card spending. */
export const NON_CARD_LINES: ReadonlySet<AmazonSummaryLineKind> = new Set(['gift-card', 'rewards']);
const DEDUCTIONS: ReadonlySet<AmazonSummaryLineKind> = new Set(['promotion', 'gift-card', 'rewards']);

const LINE_LABELS: Record<AmazonSummaryLineKind, string> = {
  'items-subtotal': 'Items',
  shipping: 'Shipping & handling',
  tax: 'Tax',
  // An Amazon Fresh order's driver tip: added to the order total and paid like the rest of it.
  tip: 'Tip',
  promotion: 'Promotions',
  'gift-card': 'Gift card applied',
  rewards: 'Points & rewards applied',
  'grand-total': 'Order total',
};

/** A summary line as the order shows it: promotions, gift cards and points are taken off ("−$5.00"). */
export function summaryLineText(line: AmazonSummaryLine): { label: string; amount: string } {
  const amount = formatMoney({ ...line.money, amountMinor: Math.abs(line.money.amountMinor) });
  return { label: LINE_LABELS[line.kind], amount: DEDUCTIONS.has(line.kind) ? `−${amount}` : amount };
}

const FAMILIES: Record<AmazonCoverageFamily, string> = {
  orders: 'Orders', payments: 'Payments', details: 'Order details', refunds: 'Refunds',
};

export function coverageFamilyLabel(family: AmazonCoverageFamily): string {
  return FAMILIES[family];
}

/** The order page's address, by the API's opaque order ref. */
export function amazonOrderHref(ref: string): string {
  return `#/everyday/amazon/orders/${ref}`;
}

export const AMAZON_LIST_HREF = '#/everyday/amazon';

/** The spending windows' switch: each one's label and, as its tooltip, the dates it covers. */
export const SPENDING_WINDOW_WORDS: Record<AmazonSpendingWindow, { label: string; title: string }> = {
  '30D': { label: '30 days', title: 'The last 30 days, today included' },
  '60D': { label: '60 days', title: 'The last 60 days, today included' },
  YTD: { label: 'YTD', title: 'Year to date: January 1 to today' },
  '1Y': { label: '1 year', title: 'The last 12 months, today included' },
  '2Y': { label: '2 years', title: 'The last 24 months, today included' },
};

/** A window in a sentence: "in the last 30 days", "in 2026 to date", "in the last year". */
export function spendingWindowPhrase(window: AmazonSpending['window']): string {
  switch (window.key) {
    case '30D': return 'in the last 30 days';
    case '60D': return 'in the last 60 days';
    case 'YTD': return `in ${window.to.slice(0, 4)} to date`;
    case '1Y': return 'in the last year';
    case '2Y': return 'in the last 2 years';
  }
}

/** A share, rounded down so it says 100% only when it is all; empty without a whole to share. */
export function shareText(part: number, whole: number): string {
  return whole > 0 ? `${Math.floor((part / whole) * 100)}%` : '';
}

/** The currency the spending figures are shown in: US dollars when the window has any, else its largest. */
export function spendingCurrency(spending: Pick<AmazonSpending, 'totals'>): string | null {
  if (spending.totals.some((total) => total.currency === 'USD')) return 'USD';
  const [largest] = [...spending.totals].sort((a, b) => b.itemMinor - a.itemMinor || (a.currency < b.currency ? -1 : 1));
  return largest?.currency ?? null;
}

/** A spending category's name; the items with none are "Uncategorized", as on their orders. */
export function spendingCategoryName(category: string | null): string {
  return category ?? 'Uncategorized';
}

/** Why a refund isn't tied to an item, after "N orders:". */
const UNATTRIBUTED_WORDS: Record<string, string> = {
  'invalid-amount': 'its amount couldn\'t be read',
  'order-total-missing': 'the order\'s total wasn\'t captured',
  'currency-mismatch': 'its items are priced in another currency',
  'exceeds-order-total': 'it is more than the order cost',
  'items-unproven': 'the order\'s item list isn\'t proven complete',
  promotion: 'a promotion leaves each item\'s share unknown',
  'mixed-tender': 'a split payment leaves each item\'s share unknown',
  'summary-incomplete': 'the order\'s summary wasn\'t fully captured',
  'no-match': 'no set of the order\'s items matches it',
  ambiguous: 'more than one set of the order\'s items matches it',
  'search-limit': 'too many sets of items to rule one out',
  conflict: 'its refunds disagree on which items',
};

/** Why refund records were left out, after their count. */
const EXCLUDED_WORDS: Record<string, string> = {
  'currency-mismatch': 'in another currency than their order',
  'exceeds-order-total': 'larger than their order',
  'multiple-orders': 'covering several orders at once',
  contradictory: 'contradictory',
  invalid: 'unreadable',
  'ambiguous-repeat': 'identical to another ledger row, maybe the same refund shown twice',
};

/** What refunds took off a window's items: those tied to items and those not, in the figures' currency. */
export function spendingRefundTaken(total: Pick<AmazonSpendingTotals, 'itemRefundMinor' | 'unattributedRefundMinor'>): number {
  return (total.itemRefundMinor ?? 0) + (total.unattributedRefundMinor ?? 0);
}

/** The refund lines of a window's coverage: what refunds took off and how, what was left out, and how they counted. */
function refundCoverageLines(spending: AmazonSpending, currency: string): string[] {
  const { refunds, orders } = spending;
  if (!refunds) {
    return orders.refunded > 0
      ? [`${plural(orders.refunded, 'order')} ${orders.refunded === 1 ? 'has' : 'have'} a refund; refunds aren't taken off item prices`] : [];
  }
  const total = spending.totals.find((entry) => entry.currency === currency);
  const count = (value: number) => value.toLocaleString('en-US');
  const result: string[] = [];
  if (orders.refunded > 0 && total) {
    const parts = [
      (total.itemRefundMinor ?? 0) > 0 ? `${formatMinor(total.itemRefundMinor ?? 0, currency)} off the items refunded` : null,
      (total.unattributedRefundMinor ?? 0) > 0
        ? `${formatMinor(total.unattributedRefundMinor ?? 0, currency)} not tied to an item, off the total only` : null,
    ].filter((part): part is string => part !== null);
    result.push(`Refunds on ${plural(orders.refunded, 'order')}${parts.length ? `: ${parts.join(' · ')}` : ''}`);
    result.push(`Amazon refunded ${formatMinor(total.refundMinor ?? 0, currency)} for them in all, tax and shipping included;`
      + ' a refund counts in the window of its order\'s date');
    const reasons = Object.entries(refunds.unattributed).filter(([, value]) => value > 0)
      .map(([reason, value]) => `${plural(value, 'order')}, ${UNATTRIBUTED_WORDS[reason] ?? 'for another reason'}`);
    if (reasons.length > 0) result.push(`Not tied to an item: ${reasons.join(' · ')}`);
  }
  const left = Object.entries(refunds.excluded).filter(([, value]) => value > 0)
    .map(([reason, value]) => `${count(value)} ${EXCLUDED_WORDS[reason] ?? 'for another reason'}`);
  if (left.length > 0) result.push(`Refunds left out, never counted: ${left.join(' · ')}`);
  const seen = [
    refunds.ledgerRefunds > 0 ? `${plural(refunds.ledgerRefunds, 'ledger refund')} seen ${count(refunds.ledgerObservations)}`
      + ` ${refunds.ledgerObservations === 1 ? 'time' : 'times'}` : null,
    refunds.refundTotals > 0 ? `${plural(refunds.refundTotals, 'order Refund Total')} seen ${count(refunds.refundTotalObservations)}`
      + ` ${refunds.refundTotalObservations === 1 ? 'time' : 'times'}` : null,
  ].filter((part): part is string => part !== null);
  if (seen.length > 0) result.push(`Each refund counted once: ${seen.join(' · ')}`);
  return result;
}

/**
 * What a window's figures cover, line by line, so no total reads as more complete than it is: how many orders' item
 * lists are proven complete (and their share of the order totals), and how many may have more items than counted;
 * the items and orders left out of item prices, and why; orders without a captured total; how many orders are tied
 * to a card charge and how many of those charges Spending itemizes; refunds: what they took off and how, what was
 * left out, and how each counted once (or, from an API that doesn't take them off, that they aren't); and amounts in
 * other currencies, never converted. Zero counts are left unsaid.
 */
export function spendingCoverageLines(spending: AmazonSpending, currency: string): string[] {
  const { orders, lines, cardCharges } = spending;
  const total = spending.totals.find((entry) => entry.currency === currency);
  const count = (value: number) => value.toLocaleString('en-US');
  const share = total && total.orderTotalMinor > 0
    ? `: ${formatMinor(total.itemsCompleteOrderTotalMinor, currency)} of ${formatMinor(total.orderTotalMinor, currency)} in order totals`
      + ` (${shareText(total.itemsCompleteOrderTotalMinor, total.orderTotalMinor)})`
    : '';
  const result = [`Items proven complete in ${count(orders.itemsComplete)} of ${plural(orders.count, 'order')}${share}`];
  // Orders with items whose capture didn't prove the list whole: some of their items may not be counted.
  const unproven = orders.count - orders.itemsComplete - orders.noLines;
  if (unproven > 0) result.push(`Not proven complete: ${plural(unproven, 'order')}, which may have more items than counted here`);
  const left = [
    lines.noPrice > 0 ? `${plural(lines.noPrice, 'item')} without a price` : null,
    lines.noQuantity > 0 ? `${plural(lines.noQuantity, 'item')} without a quantity` : null,
    orders.noLines > 0 ? `${plural(orders.noLines, 'order')} whose items weren't captured` : null,
  ].filter((part): part is string => part !== null);
  if (left.length > 0) result.push(`Left out of item prices: ${left.join(' · ')}`);
  if (orders.withTotal < orders.count) {
    result.push(`Order totals leave out ${plural(orders.count - orders.withTotal, 'order')} without a captured total`);
  }
  result.push([
    `Linked to a card charge: ${count(orders.linked)} of ${plural(orders.count, 'order')}`,
    orders.held > 0 ? `${count(orders.held)} held for review` : null,
    orders.unmatched > 0 ? `${count(orders.unmatched)} not matched` : null,
  ].filter((part): part is string => part !== null).join(' · '));
  if (cardCharges.linked > 0) {
    result.push(`Itemized in Spending: ${count(cardCharges.itemized)} of ${plural(cardCharges.linked, 'linked card charge')}`);
  }
  result.push(...refundCoverageLines(spending, currency));
  const others = spending.totals.filter((entry) => entry.currency !== currency && (entry.itemMinor > 0 || entry.orderTotalMinor > 0));
  if (others.length > 0) {
    result.push(`Also ${others.map((entry) => formatMinor(entry.itemMinor, entry.currency)).join(' and ')} of items in other currencies, not converted`);
  }
  return result;
}
