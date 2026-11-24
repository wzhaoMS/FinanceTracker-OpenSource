/**
 * The words of "what counts": how a view's card activity splits into spending, not spending and card payments, why a
 * row is suggested as precious metals, and on whose word a row is not spending. Pure, so every sentence is tested
 * without React. Each says what the data says (the descriptor's class, the amount) and no more: only the owner knows
 * what a charge bought.
 */
import {
  CARD_UNCATEGORIZED,
  type CardAccountingAmounts,
  type CardAssetSuggestionTier,
  type CardMetalsMerchantClass,
  type CardSpendingAccounting,
  type CardSpendingExclusion,
  type CardSpendingRule,
  type CardSpendingRulePreview,
} from '@finance-tracker/shared';

import { dateRangeLabel, formatMinor } from './spendingFormat';
import type { AssetSuggestionView, SpendingRuleInput } from './spendingApi';

/** Where the charges were, as people say it. */
export const MERCHANT_CLASS_LABELS: Record<CardMetalsMerchantClass, string> = {
  'bullion-dealer': 'Bullion dealer',
  'costco-online': 'Costco.com',
  'walmart-online': 'Walmart.com',
  'sams-club': "Sam's Club",
  'costco-warehouse': 'Costco warehouse',
};

export const TIER_LABELS: Record<CardAssetSuggestionTier, string> = {
  likely: 'Likely',
  possible: 'Possible',
  weak: 'Less likely',
};

/** The accounting entry in the view's currency, if there is one. */
export function accountingFor(entries: readonly CardSpendingAccounting[] | undefined, currency: string): CardSpendingAccounting | null {
  return entries?.find((entry) => entry.currency === currency) ?? null;
}

/**
 * Under the spending total, while suggestions are waiting: what they would take out, and spending without them. When
 * only refunds are waiting, confirming them adds to spending, and the sentence says so. Null when nothing is waiting in
 * view.
 */
export function pendingEffectText(entry: CardSpendingAccounting | null): string | null {
  if (!entry || entry.possibleAssetPurchases.count === 0 || entry.possibleAssetPurchases.netMinor === 0) return null;
  const possible = entry.possibleAssetPurchases.netMinor;
  const without = formatMinor(entry.spending.netMinor - possible, entry.currency);
  return possible > 0
    ? `${formatMinor(possible, entry.currency)} possibly precious metals awaiting your confirmation · ${without} without them`
    : `${formatMinor(-possible, entry.currency)} of refunds possibly for precious metals awaiting your confirmation · ${without} without them`;
}

/** Under the spending total, when asset purchases are in view: how much the owner bought and is not counted. */
export function assetPurchasesText(entry: CardSpendingAccounting | null): string | null {
  if (!entry || entry.notSpending.assetPurchases.count === 0) return null;
  return `${formatMinor(entry.notSpending.assetPurchases.netMinor, entry.currency)} precious metals bought · not counted`;
}

export interface ReconciliationPart {
  key: 'spending' | 'asset' | 'other' | 'transfers';
  label: string;
  amountMinor: number;
  count: number;
}

/**
 * The view's posted card activity, part by part: spending + precious metals + other not counted + card payments =
 * activity, to the cent (the API's accounting guarantees it; the parts are its own). Parts with no rows are left out.
 */
export function reconciliationParts(entry: CardSpendingAccounting): { activityMinor: number; parts: ReconciliationPart[] } {
  const parts: ReconciliationPart[] = [
    { key: 'spending', label: 'Spending', amountMinor: entry.spending.netMinor, count: entry.spending.count },
    { key: 'asset', label: 'Precious metals (assets)', amountMinor: entry.notSpending.assetPurchases.netMinor, count: entry.notSpending.assetPurchases.count },
    { key: 'other', label: 'Other, not counted', amountMinor: entry.notSpending.other.netMinor, count: entry.notSpending.other.count },
    { key: 'transfers', label: 'Card payments', amountMinor: entry.transfers.netMinor, count: entry.transfers.count },
  ];
  return { activityMinor: entry.activity.netMinor, parts: parts.filter((part) => part.count > 0) };
}

/** One line of the statement: a label and its signed amount. */
export interface StatementRow {
  /** The part, and its side when the part is shown as its charges and its refunds and credits apart. */
  key: 'spending-charges' | 'spending-credits' | 'asset-charges' | 'asset-credits' | 'other' | 'transfers';
  part: ReconciliationPart['key'];
  label: string;
  /** Signed as the API sums it: charges positive; refunds, credits and card payments negative. */
  amountMinor: number;
}

/** The view's posted card activity in two groups, counted as spending and not, and the activity they add up to. */
export interface WhatCountsStatement {
  counted: StatementRow[];
  notCounted: StatementRow[];
  activityMinor: number;
}

/** The two sides of the parts shown that way: what each side is called. */
const SIDES = {
  spending: { charges: ['spending-charges', 'Charges'], credits: ['spending-credits', 'Refunds and credits'] },
  asset: { charges: ['asset-charges', 'Precious metals bought'], credits: ['asset-credits', 'Precious metals refunds and credits'] },
} as const;

/**
 * The view's posted card activity as a statement, with no sum to work out: what counts as spending, then what does
 * not (precious metals, other, card payments), each line a label and its signed amount, in the order of
 * `reconciliationParts`; together they are the activity, to the cent. Spending and precious metals show their charges
 * and their refunds and credits as lines of their own where they have both: the API's own sums of a part's positive and
 * negative rows. A part whose sides do not add up to its net, or with neither, is one line at its net, so the lines
 * always add up to the activity whatever an answer holds. Other and card payments are one line each, at their net.
 * Nothing is moved between parts or named for more than its sign says.
 */
export function whatCountsStatement(entry: CardSpendingAccounting): WhatCountsStatement {
  const { activityMinor, parts } = reconciliationParts(entry);
  const sides: Record<'spending' | 'asset', CardAccountingAmounts> = { spending: entry.spending, asset: entry.notSpending.assetPurchases };
  const linesOf = (part: ReconciliationPart): StatementRow[] => {
    if (part.key === 'other') return [{ key: 'other', part: 'other', label: 'Other (cash advances and the like)', amountMinor: part.amountMinor }];
    if (part.key === 'transfers') return [{ key: 'transfers', part: 'transfers', label: 'Card payments', amountMinor: part.amountMinor }];
    const amounts = sides[part.key];
    const names = SIDES[part.key];
    const line = ([key, label]: readonly [StatementRow['key'], string], amountMinor: number): StatementRow =>
      ({ key, part: part.key, label, amountMinor });
    if (amounts.chargesMinor + amounts.creditsMinor !== part.amountMinor) return [line(part.amountMinor < 0 ? names.credits : names.charges, part.amountMinor)];
    const lines: StatementRow[] = [];
    if (amounts.chargesMinor !== 0) lines.push(line(names.charges, amounts.chargesMinor));
    if (amounts.creditsMinor !== 0) lines.push(line(names.credits, amounts.creditsMinor));
    return lines.length > 0 ? lines : [line(names.charges, part.amountMinor)];
  };
  return {
    counted: parts.filter((part) => part.key === 'spending').flatMap(linesOf),
    notCounted: parts.filter((part) => part.key !== 'spending').flatMap(linesOf),
    activityMinor,
  };
}

/**
 * Under "To confirm": that the waiting rows count as spending until the owner decides, then what confirming every one
 * would do to spending: the API's own figure (the suggested rows in view and the exact refunds that would go with them),
 * taken out, or added when refunds outweigh. No amount when it would change nothing.
 */
export function queueEffectText(entry: CardSpendingAccounting | null, waiting: number): string {
  const lead = 'Possibly precious metals, counted as spending until you decide.';
  const net = entry && entry.possibleAssetPurchases.count > 0 ? entry.possibleAssetPurchases.netMinor : 0;
  if (!entry || waiting === 0 || net === 0) return lead;
  const which = waiting === 1 ? 'Confirming it' : waiting === 2 ? 'Confirming both' : `Confirming all ${waiting}`;
  return net > 0
    ? `${lead} ${which} takes ${formatMinor(net, entry.currency)} out of spending.`
    : `${lead} ${which} adds ${formatMinor(-net, entry.currency)} to spending.`;
}

/** Under the statement, when rows are pending: they are in none of its figures until they post. */
export function pendingNoteText(entry: CardSpendingAccounting): string | null {
  const count = entry.pending.count;
  if (count === 0) return null;
  return count === 1
    ? '1 pending transaction is not in these figures until it posts.'
    : `${count} pending transactions are not in these figures until they post.`;
}

/** One sentence: why a row is suggested. The class and the amount only; the owner decides. */
export function suggestionReason(item: Pick<AssetSuggestionView, 'kind' | 'merchantClass' | 'signals' | 'currency' | 'purchaseIds'>): string {
  if (item.kind === 'refund') {
    const of = item.signals.includes('refund-of-excluded') ? 'a precious-metals purchase you confirmed' : 'a suggested purchase';
    if (item.signals.includes('ambiguous-refund')) return `More than one purchase from this seller could be the one refunded, among them ${of}`;
    if (item.signals.includes('after-earlier-refund')) return `A refund after an earlier refund of ${of}, so what is left of it is not certain`;
    if (item.signals.includes('channel-unconfirmed') && !item.signals.includes('partial-refund')) {
      return `A refund from the same seller within 90 days of ${of}, but its description doesn't show the same channel (online or in store)`;
    }
    return `A partial refund from the same seller within 90 days of ${of}`;
  }
  const where = item.merchantClass ? MERCHANT_CLASS_LABELS[item.merchantClass] : 'This merchant';
  const why = item.merchantClass === 'bullion-dealer'
    ? 'A bullion dealer'
    : item.merchantClass === 'costco-warehouse'
      ? 'A large Costco warehouse charge (Costco sells bullion online only, but some cards show online orders this way)'
      : `A large ${where} order (${where} sells bullion online)`;
  return item.signals.includes('gift-card-like') ? `${why}; a round amount, like gift cards` : why;
}

/** On whose word a row is not spending. */
export function exclusionSourceText(exclusion: CardSpendingExclusion, rules: readonly CardSpendingRule[] = []): string {
  if (exclusion.source === 'owner-category') return 'your category';
  if (exclusion.source === 'paired-refund') return 'refund of a precious-metals purchase';
  const rule = rules.find((item) => item.id === exclusion.ruleId);
  return rule ? `your rule: ${ruleText(rule)}` : 'your rule';
}

/** An owner rule, as one sentence. */
export function ruleText(rule: Pick<CardSpendingRule, 'merchantClass' | 'currency' | 'minAmountMinor'>): string {
  return `${MERCHANT_CLASS_LABELS[rule.merchantClass]} charges of ${formatMinor(rule.minAmountMinor, rule.currency)} or more are precious metals`;
}

/** What a rule would do, before the owner makes it. */
export function rulePreviewText(
  preview: Pick<CardSpendingRulePreview, 'purchases' | 'refunds' | 'amounts' | 'firstDate' | 'lastDate' | 'ownerDecided' | 'alreadyExcluded'>,
  currency: string,
): string {
  if (preview.purchases === 0 && preview.refunds === 0) {
    return preview.alreadyExcluded > 0 ? 'Every charge it covers is already out of spending.' : 'It covers no charge yet; it applies to new ones as they come in.';
  }
  const rows = [`${preview.purchases} ${preview.purchases === 1 ? 'charge' : 'charges'}`];
  if (preview.refunds > 0) rows.push(`${preview.refunds} exact ${preview.refunds === 1 ? 'refund' : 'refunds'}`);
  const span = preview.firstDate && preview.lastDate ? `, ${dateRangeLabel(preview.firstDate, preview.lastDate)}` : '';
  const kept = preview.ownerDecided > 0 ? ` It leaves ${preview.ownerDecided} you kept as spending.` : '';
  return `Takes ${formatMinor(preview.amounts.netMinor, currency)} out of spending: ${rows.join(' and ')}${span}.${kept}`;
}

/** The category "not metals" keeps as the owner's own; null when the owner has to pick one. */
export function notMetalsCategory(category: string): string | null {
  return category && category !== CARD_UNCATEGORIZED ? category : null;
}

/** The smallest amount a suggested class's rule would start at: the floor, rounded down to whole hundreds. */
export function defaultRuleMinimum(suggestions: readonly Pick<AssetSuggestionView, 'kind' | 'merchantClass' | 'amountMinor' | 'currency'>[], merchantClass: CardMetalsMerchantClass, currency: string): number {
  const amounts = suggestions.filter((item) => item.kind === 'purchase' && item.merchantClass === merchantClass && item.currency === currency)
    .map((item) => item.amountMinor);
  const smallest = amounts.length > 0 ? Math.min(...amounts) : 100_000;
  return Math.max(10_000, Math.floor(smallest / 10_000) * 10_000);
}

/**
 * The same rule: a preview speaks for the exact class, currency and minimum it was asked for, and for nothing else, so a
 * rule is made only from the preview of the very input on screen.
 */
export function sameRuleInput(a: SpendingRuleInput, b: SpendingRuleInput): boolean {
  return a.merchantClass === b.merchantClass && a.currency === b.currency && a.minAmountMinor === b.minAmountMinor;
}
