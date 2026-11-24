import {
  AMAZON_ITEM_TAXONOMY,
  AMAZON_TAXONOMY_GROCERIES,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  amazonTaxonomyNode,
  type AmazonTaxonomyNodeId,
} from '@finance-tracker/shared';

import { formatMinor } from '../spending/spendingFormat';
import { formatMoney, plural } from './amazonFormat';
import type { AmazonFresh, AmazonFreshCategory, AmazonFreshTotals, FreshUnitPrice, FreshWeight } from './amazonFreshApi';

/** Display words for the Amazon Fresh tab (AmazonFresh.tsx): only what the API reported, never derived amounts. */

/** A breakdown row's name: "Meat & Seafood", "Other groceries", "Household Supplies", "Not yet classified". */
export function freshCategoryLabel(category: AmazonTaxonomyNodeId): string {
  if (category === AMAZON_TAXONOMY_GROCERIES) return 'Other groceries';
  if (category === AMAZON_TAXONOMY_NEEDS_REVIEW) return 'Not yet classified';
  return amazonTaxonomyNode(category)?.label ?? category;
}

/** "1.25 lb", "2.1 lb (estimated)": the weight exactly as the Item List showed it. */
export function freshWeightText(weight: FreshWeight): string {
  return `${weight.value} lb${weight.basis === 'estimated' ? ' (estimated)' : ''}`;
}
/** "$3.99/lb" or "$2.50 each". */
export function freshUnitPriceText(price: FreshUnitPrice): string {
  return price.per === 'lb' ? `${formatMoney(price.money)}/lb` : `${formatMoney(price.money)} each`;
}
/**
 * What a line was, as its list showed it: "1.25 lb at $3.99/lb", "Qty 2 at $2.50 each", "Qty 2 · 2.1 lb at $0.59/lb",
 * "Qty 2". A weighed line's count shows only when it is more than one. Empty when the list showed none of them.
 */
export function freshMeasureText(line: { quantity: number | null; weight: FreshWeight | null; unitPrice: FreshUnitPrice | null }): string {
  const parts: string[] = [];
  if (line.quantity !== null && (line.weight === null || line.quantity !== 1)) parts.push(`Qty ${line.quantity.toLocaleString('en-US')}`);
  if (line.weight) parts.push(freshWeightText(line.weight));
  const shown = parts.join(' · ');
  if (!line.unitPrice) return shown;
  return shown ? `${shown} at ${freshUnitPriceText(line.unitPrice)}` : freshUnitPriceText(line.unitPrice);
}
/** A product's purchases together: "Qty 3", "2.05 lb", "Qty 2 · 4.2 lb, some estimated". */
export function freshProductMeasureText(product: { quantity: number | null; weight: { value: string; estimated: boolean } | null }): string {
  return [
    product.quantity === null ? null : `Qty ${product.quantity.toLocaleString('en-US')}`,
    product.weight === null ? null : `${product.weight.value} lb${product.weight.estimated ? ', some estimated' : ''}`,
  ].filter((part): part is string => part !== null).join(' · ');
}

/** The figures' currency: US dollars when the window has any, else its largest by order totals. */
export function freshCurrency(fresh: Pick<AmazonFresh, 'totals'>): string | null {
  if (fresh.totals.some((total) => total.currency === 'USD')) return 'USD';
  const [largest] = [...fresh.totals].sort((a, b) => b.orderTotalMinor - a.orderTotalMinor || b.lineMinor - a.lineMinor
    || (a.currency < b.currency ? -1 : 1));
  return largest?.currency ?? null;
}

const byNet = (a: AmazonFreshCategory, b: AmazonFreshCategory) => b.netMinor - a.netMinor || b.amountMinor - a.amountMinor
  || (a.category < b.category ? -1 : 1);
/**
 * The breakdown in one currency, in reading order: Groceries' subcategories largest after refunds first, then other
 * groceries (items filed on Groceries itself), then what else was bought on Fresh (Household Supplies, …) largest first,
 * and Not yet classified last.
 */
export function freshCategoryRows(fresh: Pick<AmazonFresh, 'categories'>, currency: string): AmazonFreshCategory[] {
  const rows = fresh.categories.filter((entry) => entry.currency === currency);
  return [
    ...rows.filter((entry) => entry.group === 'groceries' && entry.category !== AMAZON_TAXONOMY_GROCERIES).sort(byNet),
    ...rows.filter((entry) => entry.category === AMAZON_TAXONOMY_GROCERIES),
    ...rows.filter((entry) => entry.group === 'other').sort(byNet),
    ...rows.filter((entry) => entry.group === 'needs-review'),
  ];
}
/** Groceries' subcategories, in the taxonomy's order. */
export function groceryLabels(): string[] {
  return AMAZON_ITEM_TAXONOMY.find((top) => top.id === AMAZON_TAXONOMY_GROCERIES)!.children.map((child) => child.label);
}
/** Groceries' subcategories with nothing in them in this currency, in the taxonomy's order. */
export function emptyGroceryLabels(fresh: Pick<AmazonFresh, 'categories'>, currency: string): string[] {
  const filled = new Set(fresh.categories.filter((entry) => entry.currency === currency).map((entry) => freshCategoryLabel(entry.category)));
  return groceryLabels().filter((label) => !filled.has(label));
}

/** "Bakery & Bread, Frozen or Beverages": a short list in words. */
export function orList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}
/** "Produce, Frozen and Beverages". */
export function andList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** An order's Item List in a few words: how many items, and how sure the list is. */
export function freshListText(order: { lines: number; complete: boolean; reconciled: boolean; unreadable: number;
  unreadRows: number | null }): string {
  if (order.lines === 0) return 'Items not captured yet';
  if (order.reconciled) return `${plural(order.lines, 'item')}, list complete`;
  if (order.complete) return `${plural(order.lines, 'item')}, list complete but not matched to the item subtotal`;
  const unread = (order.unreadRows ?? 0) + order.unreadable;
  return unread > 0 ? `${plural(order.lines, 'item')}, ${plural(unread, 'row')} unread` : `${plural(order.lines, 'item')}, list not proven complete`;
}

/**
 * A currency's own priced items, and how many of them aren't classified yet: each priced line counts in exactly one
 * category row of its currency. Whether an item price was captured in it comes from these counts, never from a positive
 * amount: a captured $0.00 is a price.
 */
export function freshPricedIn(fresh: Pick<AmazonFresh, 'categories'>, currency: string): { priced: number; unclassified: number } {
  const rows = fresh.categories.filter((entry) => entry.currency === currency);
  const lines = (entries: AmazonFreshCategory[]) => entries.reduce((sum, entry) => sum + entry.lines, 0);
  return { priced: lines(rows), unclassified: lines(rows.filter((entry) => entry.group === 'needs-review')) };
}

/** Whether an order total was captured in the figures' currency (freshTotalsCaptured). */
export type FreshTotalsCaptured = 'captured' | 'none' | 'none listed';
/**
 * Whether an order total was captured in a currency, from its own evidence, never from a positive amount (a captured
 * $0.00 is a total): with one currency, any order's; with more, a listed order's, or a sum above nothing. 'none listed':
 * no listed order has one, and orders not listed (the list keeps the newest) have totals in currencies the answer
 * doesn't name, so the claim stays with the listed orders.
 */
export function freshTotalsCaptured(fresh: Pick<AmazonFresh, 'orders' | 'totals' | 'orderList'>, currency: string): FreshTotalsCaptured {
  const total = fresh.totals.find((entry) => entry.currency === currency);
  if (!total) return 'none';
  if (fresh.totals.length === 1) return fresh.orders.withTotal > 0 ? 'captured' : 'none';
  if (total.orderTotalMinor > 0 || fresh.orderList.some((order) => order.total?.currency === currency)) return 'captured';
  const unlisted = fresh.orders.withTotal - fresh.orderList.filter((order) => order.total !== null).length;
  return unlisted > 0 ? 'none listed' : 'none';
}
/** The order totals line's words when none was captured in the figures' currency: in it, when the window has others. */
export function freshTotalsMissingText(state: Exclude<FreshTotalsCaptured, 'captured'>, single: boolean, currency: string): string {
  if (single) return 'not captured for these orders';
  return state === 'none' ? `not captured in ${currency}` : `not captured in ${currency} for the listed orders`;
}

/**
 * How the net item cost adds up, under it: "$106.34 for 15 items, less $11.58 in refunds on 2 orders, $5.00 of it not
 * tied to an item." `takenMinor`: what refunds took off the items, as the tab shows it (tied to items or not); `priced`:
 * the figure's currency's own priced lines. The answer counts refunded orders across the window's currencies, so
 * `refundedOrders` is given only when it has one (null: the sentence names no order count). Refunds the records don't
 * tie to an item are said whenever there are any.
 */
export function freshNetDetailText(total: Pick<AmazonFreshTotals, 'lineMinor' | 'unattributedRefundMinor'>, takenMinor: number,
  priced: number, refundedOrders: number | null, currency: string): string {
  const items = `${formatMinor(total.lineMinor, currency)} for ${plural(priced, 'item')}`;
  if (takenMinor === 0) {
    if (refundedOrders !== null && refundedOrders > 0) return `${items}; refunds on ${plural(refundedOrders, 'order')} took nothing off the items.`;
    return refundedOrders === null ? `${items}; no refunds taken off them.` : `${items}; no refunds for these orders.`;
  }
  const unattributed = total.unattributedRefundMinor > 0
    ? `, ${formatMinor(total.unattributedRefundMinor, currency)} of it not tied to an item` : '';
  const on = refundedOrders === null ? '' : ` on ${plural(refundedOrders, 'order')}`;
  return `${items}, less ${formatMinor(takenMinor, currency)} in refunds${on}${unattributed}.`;
}

/**
 * The orders whose Item List isn't proven complete (not captured, or not proven whole), said beside the figures they
 * limit: "Items may be missing from 2 orders". Null when every list is proven complete.
 */
export function freshMayMissText(orders: Pick<AmazonFresh['orders'], 'count' | 'complete'>): string | null {
  const count = orders.count - orders.complete;
  return count > 0 ? `Items may be missing from ${plural(count, 'order')}` : null;
}

/**
 * What the orders' own totals cover, after the amount: "for 3 Fresh orders, tax, delivery and tips included", or "for 3
 * of 4 Fresh orders (1 order without a captured total), …". The counts are the window's, across its currencies, so
 * `single` (one currency) is needed to say them.
 */
export function freshOrderTotalsNote(orders: Pick<AmazonFresh['orders'], 'count' | 'withTotal'>, single: boolean): string {
  if (!single) return 'tax, delivery and tips included';
  const without = orders.count - orders.withTotal;
  return without > 0
    ? `for ${orders.withTotal.toLocaleString('en-US')} of ${plural(orders.count, 'Fresh order')} (${plural(without, 'order')} without a captured total), tax, delivery and tips included`
    : `for ${plural(orders.count, 'Fresh order')}, tax, delivery and tips included`;
}
