import {
  ITEM_TAXONOMY_ASSET_NODE,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_V2_VIEW,
  type ItemTaxonomyV2NodeId,
} from '@finance-tracker/shared';
import type {
  RetailApiCarrier,
  RetailApiCaptureRange,
  RetailApiChannel,
  RetailApiChannelCounts,
  RetailApiCoverageChannel,
  RetailApiFuel,
  RetailApiFulfilment,
  RetailApiLine,
  RetailApiLineEventKind,
  RetailApiLineEvents,
  RetailApiLineKind,
  RetailApiLineMetal,
  RetailApiLineMetalUncertain,
  RetailApiMatchingLine,
  RetailApiMetal,
  RetailApiMetalGuardEvidence,
  RetailApiNetwork,
  RetailApiOnlineStatus,
  RetailApiQuarantineReason,
  RetailApiReceiptRow,
  RetailApiRowTenders,
  RetailApiShipment,
  RetailApiSign,
  RetailApiSummary,
  RetailApiTender,
  RetailApiTenderKind,
  RetailApiTotals,
} from '@finance-tracker/shared/retail-api';

import { ApiError } from '../../services/api';
import { dateRangeLabel, longDate } from '../spending/spendingFormat';
import { CostcoAnswerError, CostcoRequestError, parseCostcoConflict } from './costcoApi';

/**
 * Display words for the Costco receipts page. Every figure is one receipt's own, as it states it: nothing here adds
 * amounts of several receipts, and only counts (receipts, records) are ever said across them.
 */

/** Said above every state of the page: loading, failed, nothing imported, the list and a receipt. */
export const COSTCO_BANNER = 'Receipt detail only. Each purchase is already in Spending as its card charge; nothing on this page adds to any total.';
export const COSTCO_ABSENT = 'No Costco receipts imported yet.';
export const COSTCO_METAL_TAG = 'Precious metal - not everyday spending';
/** Beside an agent's category that it was only 60% to 80% sure of: filed there, for the owner to confirm. */
export const COSTCO_SUGGESTED = 'Suggested';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Cents as dollars, "$1,234.56"; a negative amount (a refund, a coupon) with a minus sign, "−$12.34". */
export function costcoMoney(amountMinor: number): string {
  const amount = USD.format(Math.abs(amountMinor) / 100);
  return amountMinor < 0 ? `−${amount}` : amount;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export const CHANNEL_LABELS: Record<RetailApiChannel, string> = { warehouse: 'Warehouse', gas: 'Gas', online: 'Online' };
/** A capture's coverage: gas receipts come with the warehouse's. */
export const COVERAGE_LABELS: Record<RetailApiCoverageChannel, string> = { online: 'Online', warehouse: 'Warehouse and gas' };
export const SIGN_LABELS: Record<RetailApiSign, string> = { sale: 'Sale', refund: 'Refund' };
export const TENDER_KIND_LABELS: Record<RetailApiTenderKind, string> = {
  card: 'Card',
  'card-refund': 'Card refund',
  debit: 'Debit',
  cash: 'Cash',
  'shop-card': 'Shop Card',
  'reward-certificate': 'Reward certificate',
  coupon: 'Coupon',
};
export const NETWORK_LABELS: Record<RetailApiNetwork, string> = { visa: 'Visa', mastercard: 'Mastercard', unknown: 'Card' };
export const ONLINE_STATUS_LABELS: Record<RetailApiOnlineStatus, string> = {
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned', other: 'Other status',
};
export const FULFILMENT_LABELS: Record<RetailApiFulfilment, string> = {
  parcel: 'Parcel', email: 'By email', 'delivery-setup': 'Delivery and setup', unknown: 'Fulfilment not stated',
};
export const CARRIER_LABELS: Record<RetailApiCarrier, string> = { ups: 'UPS', fedex: 'FedEx', usps: 'USPS', other: 'Other carrier' };
export const METAL_LABELS: Record<RetailApiMetal, string> = { XAU: 'Gold', XAG: 'Silver', XPT: 'Platinum', XPD: 'Palladium' };
export const LINE_KIND_LABELS: Record<RetailApiLineKind, string> = { item: 'Item', fee: 'Fee', coupon: 'Coupon', fuel: 'Fuel' };
export const LINE_EVENT_LABELS: Record<RetailApiLineEventKind, string> = {
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned',
};

/** Why a receipt is under review, in plain words (its first reason). */
export const QUARANTINE_REASON_TEXT: Record<RetailApiQuarantineReason, string> = {
  'duplicate-across-memberships': 'another membership imported this receipt with different details',
  'receipt-changed': 'a later capture shows this receipt with different details',
  'policy-reread-changed': 'reading it again under a newer import policy changed its details',
  'receipt-held-later': 'a later capture held a record of this receipt back',
};

export function underReviewText(reason: RetailApiQuarantineReason): string {
  return `Under review — ${QUARANTINE_REASON_TEXT[reason]}`;
}

/** A card as the receipt states it: "Visa ···0007". */
export function cardText(network: RetailApiNetwork, last4: string | null): string {
  const name = NETWORK_LABELS[network];
  return last4 === null ? `${name} (last four not stated)` : `${name} ···${last4}`;
}

/** A tender's kind, with its card for a card or card refund: "Card · Visa ···0007", "Card refund ···0011", "Shop Card". */
export function tenderText(tender: Pick<RetailApiTender, 'kind' | 'network' | 'last4'>): string {
  const kind = TENDER_KIND_LABELS[tender.kind];
  if (tender.kind !== 'card' && tender.kind !== 'card-refund') return kind;
  if (tender.network === 'unknown') return tender.last4 === null ? kind : `${kind} ···${tender.last4}`;
  return `${kind} · ${cardText(tender.network, tender.last4)}`;
}

/** How a receipt was paid, by kind: "Card, Shop Card". */
export function tenderKindsText(kinds: readonly RetailApiTenderKind[]): string {
  return kinds.length === 0 ? 'No tender stated' : kinds.map((kind) => TENDER_KIND_LABELS[kind]).join(', ');
}

/** One receipt's own tenders, split: what a card paid (already in Spending) and what else paid. */
export function rowSplitText(tenders: Pick<RetailApiRowTenders, 'cardSpendingMinor' | 'otherMinor'>): string {
  return `Card ${costcoMoney(tenders.cardSpendingMinor)} · Other ${costcoMoney(tenders.otherMinor)}`;
}

export function costcoDate(date: string): string {
  return longDate(date);
}

/**
 * A receipt's name: "warehouse receipt of Nov 2, 2026", "online order of …", "gas refund of …"; as a `title`,
 * "Warehouse receipt · Nov 2, 2026".
 */
export function receiptNameText(channel: RetailApiChannel, sign: RetailApiSign, date: string, title = false): string {
  const name = `${CHANNEL_LABELS[channel]} ${sign === 'refund' ? 'refund' : channel === 'online' ? 'order' : 'receipt'}`;
  return title ? `${name} · ${longDate(date)}` : `${name.toLowerCase()} of ${longDate(date)}`;
}

/** The receipt's date and, when Costco gives it, its local time as stated. */
export function receiptWhenText(date: string, localTime: string | null): string {
  return localTime === null ? longDate(date) : `${longDate(date)}, ${localTime}`;
}

/** A membership's latest capture date (YYYY-MM-DD), or that none was imported. */
export function captureText(capturedThrough: string | null): string {
  return capturedThrough === null ? 'No capture imported yet' : `Captured through ${longDate(capturedThrough)}`;
}

export function captureRangeText(range: RetailApiCaptureRange): string {
  return `${COVERAGE_LABELS[range.channel]}: ${dateRangeLabel(range.from, range.to)}`;
}

export function itemCountText(count: number): string {
  return plural(count, 'item');
}

/** A list row's items: a gas receipt is its fuel. */
export function rowItemsText(row: Pick<RetailApiReceiptRow, 'channel' | 'itemLines'>): string {
  return row.channel === 'gas' && row.itemLines === 0 ? 'Fuel' : itemCountText(row.itemLines);
}

export function receiptCountText(count: number): string {
  return plural(count, 'receipt');
}

/** One channel's receipts: active, and those under review. */
export function channelCountsText(counts: RetailApiChannelCounts): string {
  if (counts.quarantined === 0) return receiptCountText(counts.active);
  return `${counts.active.toLocaleString('en-US')} active, ${counts.quarantined.toLocaleString('en-US')} under review`;
}

export function heldText(held: number): string {
  return `${plural(held, 'record')} held (not receipts)`;
}

/** Which receipts of how many a page shows: "Receipts 51–100 of 132". Counts only. */
export function pageText(offset: number, shown: number, total: number): string {
  if (shown === 0) return receiptCountText(total);
  return `Receipts ${(offset + 1).toLocaleString('en-US')}–${(offset + shown).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** Each membership's own label, by ref, from the summary. */
export function membershipLabels(summary: RetailApiSummary | null): Map<string, string> {
  if (summary === null || summary.state !== 'present') return new Map();
  return new Map(summary.memberships.map((membership) => [membership.membershipRef, membership.label]));
}

export function membershipsText(refs: readonly string[], labels: ReadonlyMap<string, string>): string {
  if (refs.length === 0) return 'No membership stated';
  return refs.map((ref) => labels.get(ref) ?? 'Membership not in the summary').join(', ');
}

const UNTITLED: Record<RetailApiLineKind, string> = { item: 'Item (title not shown)', fee: 'Fee', coupon: 'Coupon', fuel: 'Fuel' };

/** A line's title; without one, its item number ("Item 1234567"); without either, its kind. */
export function lineTitle(line: Pick<RetailApiLine, 'kind' | 'title' | 'itemNumber'>): string {
  if (line.title !== null) return line.title;
  if (line.itemNumber !== null) return `Item ${line.itemNumber}`;
  return UNTITLED[line.kind];
}

/** A line a search matched, on one line: its kind (not for an item), its title, second description, item number and quantity. */
export function matchingLineText(line: RetailApiMatchingLine): string {
  return [
    line.kind === 'item' ? null : LINE_KIND_LABELS[line.kind],
    shownLineTitle(line),
    line.title2,
    line.title !== null && line.itemNumber !== null ? `Item ${line.itemNumber}` : null,
    line.quantity !== null && line.quantity !== 1 ? `Qty ${line.quantity.toLocaleString('en-US')}` : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

/** The title a line shows beside its kind: none when it would only repeat the kind ("Coupon Coupon"). */
export function shownLineTitle(line: Pick<RetailApiLine, 'kind' | 'title' | 'itemNumber'>): string | null {
  return line.kind !== 'item' && line.title === null && line.itemNumber === null ? null : lineTitle(line);
}

/** What kind of line it is, when not an item: a coupon on the whole receipt, or one whose line isn't on it, says so. */
export function lineKindText(line: Pick<RetailApiLine, 'kind' | 'couponFor'>, orphan: boolean): string | null {
  if (line.kind === 'item') return null;
  if (line.kind === 'fuel') return LINE_KIND_LABELS.fuel;
  if (orphan) return `${LINE_KIND_LABELS[line.kind]} for a line not on this receipt`;
  if (line.kind === 'coupon' && line.couponFor === null) return 'Coupon on the whole receipt';
  return LINE_KIND_LABELS[line.kind];
}

/** Quantity and unit price as stated: "2 × $4.99". */
export function quantityText(line: Pick<RetailApiLine, 'quantity' | 'unitPriceMinor'>): string | null {
  if (line.quantity === null) return line.unitPriceMinor === null ? null : `${costcoMoney(line.unitPriceMinor)} each`;
  const quantity = line.quantity.toLocaleString('en-US');
  return line.unitPriceMinor === null ? `Qty ${quantity}` : `${quantity} × ${costcoMoney(line.unitPriceMinor)}`;
}

/** Fuel exactly as stated, the price per gallon unrounded: "12.345 gal at $3.459/gal". */
export function fuelText(fuel: RetailApiFuel): string {
  if (fuel.gallons === null && fuel.unitPrice === null) return 'Gallons and price not stated';
  if (fuel.unitPrice === null) return `${fuel.gallons} gal`;
  if (fuel.gallons === null) return `$${fuel.unitPrice}/gal`;
  return `${fuel.gallons} gal at $${fuel.unitPrice}/gal`;
}

/** A metal line's stored facts: "Gold · bar · 1 ozt". */
export function metalDetailText(metal: Pick<RetailApiLineMetal, 'metal' | 'form' | 'statedWeight' | 'pack'>): string {
  return [
    metal.metal === null ? 'Metal not named' : METAL_LABELS[metal.metal],
    metal.form,
    metal.statedWeight === null ? null : `${metal.statedWeight.value} ${metal.statedWeight.unit}`,
    metal.pack === 'multiple' ? 'more than one piece' : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

const EVIDENCE_TEXT: Record<RetailApiMetalGuardEvidence, string> = {
  'bullion-word': 'a bullion word',
  'design-after-metal': 'a design named after the metal',
  'shape-with-weight': 'a shape with a weight',
  'troy-or-metric-weight': 'a troy or metric weight',
  purity: 'a purity',
  adjacency: 'a shape word beside the metal word',
};

/** The metal guard's flag: the title names a metal with bullion evidence, but didn't read as a precious metal. */
export function metalUncertainText(flag: Pick<RetailApiLineMetalUncertain, 'metal' | 'evidence'>): string {
  const metal = flag.metal === null ? 'a metal' : METAL_LABELS[flag.metal].toLowerCase();
  const words = flag.evidence.map((entry) => EVIDENCE_TEXT[entry]);
  const evidence = words.length === 0 ? '' : ` with ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`}`;
  return `Uncertain metal: its title names ${metal}${evidence}, but it didn't read as a precious metal.`;
}

/** A node of the shared item tree (v2) by its labels from the top down: "Needs review", "Groceries › Beverages". */
export function categoryText(node: ItemTaxonomyV2NodeId): string {
  return ITEM_TAXONOMY_V2_VIEW.path(node).join(' › ');
}

/**
 * Whether a line is tagged a precious metal, not everyday spending (`COSTCO_METAL_TAG`): it has stored metal facts, its
 * category is the asset node, or its category holds it for metal evidence (`metalHold`), whatever its node.
 */
export function isMetalLine(line: Pick<RetailApiLine, 'metal' | 'category'>): boolean {
  return line.metal !== null || (line.category !== null && (line.category.node === ITEM_TAXONOMY_ASSET_NODE || line.category.metalHold));
}

/** A line's category as its chip shows it. */
export interface CostcoCategoryChip {
  node: ItemTaxonomyV2NodeId;
  /** `categoryText`: the node's labels from the top down. */
  text: string;
  /** Needs review, the residual: where a line without a usable category is listed. Shown muted. */
  review: boolean;
  /** An agent's category it was only fairly sure of (`suggested`): marked `COSTCO_SUGGESTED`. */
  suggested: boolean;
}

/**
 * The category chip a line shows: none on a coupon (whose category is null; it shows under its item), and none on a
 * metal line, which keeps the precious-metal tag instead. A suggestion kept with Needs review isn't shown.
 */
export function categoryChip(line: Pick<RetailApiLine, 'metal' | 'category'>): CostcoCategoryChip | null {
  const { category } = line;
  if (category === null || isMetalLine(line)) return null;
  return { node: category.node, text: categoryText(category.node), review: category.node === ITEM_TAXONOMY_RESIDUAL, suggested: category.suggested };
}

/** One choice of the category filter: the node it asks for and the words the list shows. */
export interface CostcoCategoryOption {
  node: ItemTaxonomyV2NodeId;
  text: string;
}

/** A top level of the filter: a group (its whole top level, then each subcategory), or one choice when it has none. */
export type CostcoCategoryChoice =
  | { kind: 'node'; option: CostcoCategoryOption }
  | { kind: 'group'; label: string; options: CostcoCategoryOption[] };

const CATEGORY_CHOICES: readonly CostcoCategoryChoice[] = Object.freeze(ITEM_TAXONOMY_V2_VIEW.nodes
  .filter((node) => node.parent === null)
  .map((top): CostcoCategoryChoice => (top.children.length === 0
    ? { kind: 'node', option: { node: top.id, text: top.label } }
    : { kind: 'group', label: top.label, options: [
      // The top level itself asks for its subcategories too (the API's rule for a top level).
      { node: top.id, text: `All ${top.label}` },
      ...top.children.map((id) => ({ node: id, text: ITEM_TAXONOMY_V2_VIEW.node(id)!.label })),
    ] })));

/**
 * The category filter's choices after "All categories": every node of the shared item tree (v2), in its display order,
 * by its labels from the tree. Needs review and Precious metals are top levels of their own.
 */
export function categoryFilterOptions(): readonly CostcoCategoryChoice[] {
  return CATEGORY_CHOICES;
}

/** An online line's events, each as stated: "Shipped 1 on Oct 3, 2026". */
export function lineEventTexts(events: RetailApiLineEvents | null): string[] {
  if (events === null) return [];
  return (Object.keys(LINE_EVENT_LABELS) as RetailApiLineEventKind[]).flatMap((kind) => events[kind].map(
    (event) => `${LINE_EVENT_LABELS[kind]} ${event.quantity.toLocaleString('en-US')} on ${longDate(event.date)}`));
}

/** A shipment: its carrier and dates; an estimate only while no delivery is stated. */
export function shipmentText(shipment: RetailApiShipment): string {
  return [
    shipment.carrier === null ? 'Carrier not stated' : CARRIER_LABELS[shipment.carrier],
    shipment.shippedDate === null ? null : `shipped ${longDate(shipment.shippedDate)}`,
    shipment.deliveredDate === null ? null : `delivered ${longDate(shipment.deliveredDate)}`,
    shipment.deliveredDate === null && shipment.estimatedArrivalDate !== null ? `expected ${longDate(shipment.estimatedArrivalDate)}` : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

/**
 * The receipt's totals, in the order the receipt forms its total. Two read as what they are, not as amounts to add:
 * instant savings are already in the lines (a warehouse receipt's total is its subtotal and tax), and the Shop Card
 * amount is what a Shop Card paid toward an online order (taken off before its card is charged).
 */
const TOTAL_ROWS: ReadonlyArray<{ key: keyof RetailApiTotals; label: string }> = [
  { key: 'subtotalMinor', label: 'Subtotal' },
  { key: 'instantSavingsMinor', label: 'Instant savings (in the lines above)' },
  { key: 'discountMinor', label: 'Discount' },
  { key: 'shippingMinor', label: 'Shipping' },
  { key: 'feesMinor', label: 'Fees' },
  { key: 'taxMinor', label: 'Tax' },
  { key: 'storedValueMinor', label: 'Shop Card applied' },
  { key: 'totalMinor', label: 'Total' },
];

/** The receipt's own totals, each as stated; one it doesn't state is left out, never shown as $0.00. */
export function totalsRows(totals: RetailApiTotals): Array<{ key: keyof RetailApiTotals; label: string; amount: string }> {
  return TOTAL_ROWS.flatMap(({ key, label }) => {
    const amount = totals[key];
    return amount === null ? [] : [{ key, label, amount: costcoMoney(amount) }];
  });
}

/** One line of a receipt and the coupons and fees that sit under it. */
export interface CostcoLineGroup {
  line: RetailApiLine;
  /** Coupons under the line they discount and fees under their parent (through one another too), in receipt order. */
  children: RetailApiLine[];
  /** A coupon or fee whose line isn't on this receipt: kept in its own place, and said so. */
  orphan: boolean;
}

/**
 * A receipt's lines as the page shows them: every line in the receipt's order, each coupon under the line it discounts
 * and each fee under its parent. A receipt-level coupon (`couponFor` null), and a coupon or fee whose line isn't on
 * the receipt (or that would sit under itself), stays in its own place. No line is ever dropped or added up.
 */
export function groupCostcoLines(lines: readonly RetailApiLine[]): CostcoLineGroup[] {
  const byRef = new Map(lines.map((line) => [line.lineRef, line]));
  const placed = new Map<string, { root: string | null; orphan: boolean }>();
  const anchorOf = (line: RetailApiLine) => (line.kind === 'coupon' ? line.couponFor : line.kind === 'fee' ? line.feeOf : null);

  // Where a line sits: on its own (root null) or under the top-level line its chain of coupons and fees ends at.
  const place = (line: RetailApiLine, path: Set<string>): { root: string | null; orphan: boolean } => {
    const known = placed.get(line.lineRef);
    if (known) return known;
    const anchor = anchorOf(line);
    let result: { root: string | null; orphan: boolean };
    if (anchor === null) {
      result = { root: null, orphan: false };
    } else {
      const target = byRef.get(anchor);
      if (target === undefined || anchor === line.lineRef || path.has(anchor)) {
        result = { root: null, orphan: true };
      } else {
        path.add(line.lineRef);
        const above = place(target, path);
        path.delete(line.lineRef);
        result = { root: above.root ?? target.lineRef, orphan: false };
      }
    }
    placed.set(line.lineRef, result);
    return result;
  };

  const groups: CostcoLineGroup[] = [];
  const byRoot = new Map<string, CostcoLineGroup>();
  for (const line of lines) {
    const where = place(line, new Set());
    if (where.root !== null) continue;
    const group: CostcoLineGroup = { line, children: [], orphan: where.orphan };
    groups.push(group);
    byRoot.set(line.lineRef, group);
  }
  for (const line of lines) {
    const root = place(line, new Set()).root;
    if (root !== null) byRoot.get(root)?.children.push(line);
  }
  return groups;
}

/**
 * What failed, in fixed words: never the server's text or anything a body said. `read` is what was being read: a
 * receipt's 404 means it isn't in Holdr; the summary's or list's, that this API doesn't serve the page.
 */
export function costcoErrorText(error: unknown, read: 'receipts' | 'receipt'): string {
  if (error instanceof CostcoAnswerError) return 'Holdr couldn\'t read this answer as Costco receipts, so none of it is shown.';
  if (error instanceof CostcoRequestError) return 'Holdr didn\'t ask: that request is outside what the page may send.';
  if (error instanceof ApiError) {
    if (error.status === 409) {
      let reason = null;
      try {
        reason = parseCostcoConflict(JSON.parse(error.body));
      } catch {
        reason = null;
      }
      if (reason === 'schema-conflict') return 'The retail tables on this Holdr have another shape, so nothing was read.';
      if (reason === 'retail-reserved-value') return 'The retail tables on this Holdr hold a value reserved for a later rule, so nothing was read.';
      return 'Holdr refused to read the Costco receipts.';
    }
    if (error.status === 404) return read === 'receipt' ? 'This receipt isn\'t in Holdr.' : 'This Holdr doesn\'t serve Costco receipts.';
    if (error.status === 403) return 'Costco receipts are only for the owner\'s own session.';
    return `Holdr couldn't load the Costco receipts (HTTP ${error.status}).`;
  }
  return 'Holdr couldn\'t load the Costco receipts. Check the connection and try again.';
}
