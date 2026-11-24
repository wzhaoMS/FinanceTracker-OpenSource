import {
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  amazonTaxonomyNode,
  amazonTaxonomyPath,
  type AmazonTaxonomyNodeId,
  type AmazonTaxonomyTopId,
} from '@finance-tracker/shared';

import { formatMinor } from '../spending/spendingFormat';
import type { AmazonTaxonomyNodeTotal, AmazonTaxonomyProduct, AmazonTaxonomySpending } from './amazonTaxonomyApi';
import { plural } from './amazonFormat';

/** Display words for spending by item taxonomy (AmazonTaxonomySpending.tsx): only what the API reported. */

/** A node's own label: "Meat & Seafood". */
export function taxonomyLabel(id: AmazonTaxonomyNodeId): string {
  return amazonTaxonomyNode(id)?.label ?? id;
}
/** A node from its top level down: "Groceries › Meat & Seafood". */
export function taxonomyPathText(id: AmazonTaxonomyNodeId): string {
  return amazonTaxonomyPath(id).join(' › ');
}
/** Items filed on a top level itself, beside its subcategories: "Other Groceries". */
export function otherLabel(top: AmazonTaxonomyTopId): string {
  return `Other ${taxonomyLabel(top)}`;
}

/** Who filed an item where it is, in a few words; Needs review says why it is there. */
export function taxonomySourceText(product: Pick<AmazonTaxonomyProduct, 'node' | 'source' | 'confidence' | 'suggested' | 'suggestion'>): string {
  const sure = (confidence: number) => `${Math.round(confidence * 100)}% sure`;
  if (product.source === 'owner') return 'your choice';
  if (product.source === 'agent') {
    const confidence = product.confidence === null ? '' : `, ${sure(product.confidence)}`;
    if (product.node === AMAZON_TAXONOMY_NEEDS_REVIEW) return `the classifier couldn't tell${confidence}`;
    return product.suggested ? `suggested from its title${confidence}` : `classified from its title${confidence}`;
  }
  if (product.suggestion) return `best guess ${taxonomyPathText(product.suggestion.node)}, only ${sure(product.suggestion.confidence)}`;
  return 'not classified yet';
}

/**
 * The card category the item's order shows, by its own part of Spending's name ("Merchandise & Supplies-Groceries" is
 * "Groceries"), or that it has none.
 */
export function cardCategoryText(product: Pick<AmazonTaxonomyProduct, 'cardCategory'>): string {
  if (product.cardCategory === null) return 'Uncategorized on cards';
  const dash = product.cardCategory.indexOf('-');
  return `Card category: ${dash > 0 && dash < product.cardCategory.length - 1 ? product.cardCategory.slice(dash + 1) : product.cardCategory}`;
}

/** The figures' currency: US dollars when the window has any, else its largest. */
export function taxonomyCurrency(spending: Pick<AmazonTaxonomySpending, 'totals'>): string | null {
  if (spending.totals.some((total) => total.currency === 'USD')) return 'USD';
  const [largest] = [...spending.totals].sort((a, b) => b.itemMinor - a.itemMinor || (a.currency < b.currency ? -1 : 1));
  return largest?.currency ?? null;
}

/** One row of a ranked list; an "Other …" row's orders aren't reported apart from its top level's (null). */
export interface TaxonomyRow {
  node: AmazonTaxonomyNodeId | null;
  /** Before refunds; taken off by the refunds tied to its items; after them. */
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  orders: number | null;
  refundedOrders: number | null;
}

/** A row's note: "12 items · 3 orders", how many of those orders have a refund, and what refunds took off. */
export function nodeNote(row: Pick<TaxonomyRow, 'lines' | 'orders' | 'refundedOrders' | 'amountMinor' | 'refundMinor'>, currency: string): string {
  return [
    plural(row.lines, 'item'),
    row.orders === null ? null : plural(row.orders, 'order'),
    row.refundMinor > 0 ? `${formatMinor(row.refundMinor, currency)} refunded of ${formatMinor(row.amountMinor, currency)}`
      : row.refundedOrders ? `${row.refundedOrders.toLocaleString('en-US')} with a refund` : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

/** A node's totals in one currency, as a row. */
export function nodeRow(node: AmazonTaxonomyNodeTotal): TaxonomyRow {
  return { node: node.node, amountMinor: node.amountMinor, refundMinor: node.refundMinor, netMinor: node.netMinor, lines: node.lines,
    orders: node.orders, refundedOrders: node.refundedOrders };
}
const byNet = (a: TaxonomyRow, b: TaxonomyRow) => b.netMinor - a.netMinor || b.amountMinor - a.amountMinor;

/**
 * A top level's subcategories with items in one currency, largest after refunds first, then the items filed on the
 * top level itself ("Other …", node null) when there are any: what its totals hold beyond its subcategories'. Empty
 * for a top level without subcategory items.
 */
export function subcategoryRows(spending: Pick<AmazonTaxonomySpending, 'nodes'>, currency: string, top: AmazonTaxonomyTopId): TaxonomyRow[] {
  const inCurrency = spending.nodes.filter((entry) => entry.currency === currency);
  const total = inCurrency.find((entry) => entry.node === top);
  const children = inCurrency.filter((entry) => amazonTaxonomyNode(entry.node)?.parent === top).map(nodeRow).sort(byNet);
  if (!total || children.length === 0) return [];
  const less = (field: 'amountMinor' | 'refundMinor' | 'netMinor' | 'lines') => total[field] - children.reduce((sum, row) => sum + row[field], 0);
  if (less('lines') > 0) {
    children.push({ node: null, amountMinor: less('amountMinor'), refundMinor: less('refundMinor'), netMinor: less('netMinor'),
      lines: less('lines'), orders: null, refundedOrders: null });
  }
  return children;
}

/** The top levels with items in one currency, largest after refunds first, Needs review last. */
export function topRows(spending: Pick<AmazonTaxonomySpending, 'nodes'>, currency: string): TaxonomyRow[] {
  return spending.nodes.filter((entry) => entry.currency === currency && amazonTaxonomyNode(entry.node)?.parent === null).map(nodeRow)
    .sort((a, b) => Number(a.node === AMAZON_TAXONOMY_NEEDS_REVIEW) - Number(b.node === AMAZON_TAXONOMY_NEEDS_REVIEW) || byNet(a, b));
}