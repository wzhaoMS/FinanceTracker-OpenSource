/**
 * The read contracts Spending, P1 and P2 use (design v8 §10), from the card links alone.
 *
 * - A receipt-confirmed charge: a card row linked as proof (never a candidate) under `costco-settled-tender@1` or
 *   `walmart-order-total@1`, by an order whose skeleton's money lines are all metal (a content hold doesn't matter),
 *    named by its metals. "All metal" means every principal line (item or fuel) is metal: fee and coupon lines follow
  *   their own line, and an order-level fee or discount (never flagged metal itself) can only land on those lines. It is
  *   evidence for the owner's opt-in rule, never a decision by itself.
 * - `metalsChargeParts(row)`, per proof-linked row only, with no consumer in Spending until P2's own reviewed design:
 *   (1) an all-metal order: the whole row is one precious-metals part, whatever its tenders; (2) an order whose only
 *   tender is one card whose card evidence is the full price, with no unattributed cost (every order-level component
 *   attributed and every line complete, whatever the unattributed components would net to): the lines' totals, metal
 *   and other, summing to the row exactly; (3) anything else: no parts (`parts-unprovable`). A Shop Card redemption is
 *   funding, never a part.
 *
 * Pure: no file system, network or clock.
 */

import { metalsAllocation } from '../allocation.js';
import type { Metal, MetalsAdmissionFacts, MetalsEvidenceClass, MetalsOrderComponent, MetalsSkeletonLine } from '../model.js';
import type { MetalsCardLinkGraph } from './cardLinks.js';

/** What the read side needs of a linked order's active version. */
export interface MetalsChargeOrder {
  orderKey: string;
  skeleton: readonly MetalsSkeletonLine[];
  components: readonly MetalsOrderComponent[];
  admission: MetalsAdmissionFacts;
  /** The metal of each metal line (null when the title named several), by skeleton ordinal. */
  metals: ReadonlyMap<number, Metal | null>;
}

export type MetalsChargeMetal = Metal | 'metal-unknown';

export interface MetalsReceiptCharge {
  rowId: string;
  subject: string;
  orderKey: string;
  evidenceClass: MetalsEvidenceClass;
  metals: MetalsChargeMetal[];
}

export type MetalsChargeParts =
  | { provable: true; basis: 'all-metal' | 'single-card-full-price'; parts: Array<{ kind: 'precious-metals' | 'other'; metals: MetalsChargeMetal[]; amountMinor: number }> }
  | { provable: false; reason: 'not-linked' | 'parts-unprovable' };

/**
 * Every principal line (item or fuel) is metal, so all of the order's money is: a fee or coupon line carries its own
 * line's flag, and an order-level one (never flagged metal) is shared over the principal lines (§4.4.2).
 */
function allMetal(order: MetalsChargeOrder): boolean {
  const principals = order.skeleton.filter((line) => line.kind === 'item' || line.kind === 'fuel');
  return principals.length > 0 && principals.every((line) => line.metal);
}

function metalsOf(order: MetalsChargeOrder, ordinals?: readonly number[]): MetalsChargeMetal[] {
  const found = new Set<MetalsChargeMetal>();
  for (const [ordinal, metal] of order.metals) {
    if (ordinals && !ordinals.includes(ordinal)) continue;
    found.add(metal ?? 'metal-unknown');
  }
  return [...found].sort();
}

/** Every receipt-confirmed charge: proof links whose orders' money lines are all metal. */
export function metalsReceiptCharges(graph: MetalsCardLinkGraph, orders: ReadonlyMap<string, MetalsChargeOrder>): MetalsReceiptCharge[] {
  const charges: MetalsReceiptCharge[] = [];
  for (const link of graph.links) {
    if (!link.proof || link.rowId === null) continue;
    const order = orders.get(link.orderKey);
    if (!order || !allMetal(order)) continue;
    charges.push({ rowId: link.rowId, subject: link.subject, orderKey: link.orderKey, evidenceClass: link.evidenceClass, metals: metalsOf(order) });
  }
  return charges;
}

/** A proof-linked row's parts, or why it has none. */
export function metalsChargeParts(rowId: string, graph: MetalsCardLinkGraph, orders: ReadonlyMap<string, MetalsChargeOrder>): MetalsChargeParts {
  const subject = graph.proofByRow.get(rowId);
  const link = subject === undefined ? undefined : graph.links.find((entry) => entry.subject === subject && entry.proof);
  const order = link === undefined ? undefined : orders.get(link.orderKey);
  if (!link || !order) return { provable: false, reason: 'not-linked' };
  if (allMetal(order)) {
    return { provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: metalsOf(order), amountMinor: link.amountMinor }] };
  }
  const allocation = metalsAllocation(order.skeleton, order.components);
  const [method] = order.admission.methods;
  // Every component attributed and every line complete: an unattributed tax and an equal and opposite unattributed
  // discount net to zero but still leave each line's part unknown.
  const allAttributed = allocation.components.every((component) => component.attributed) && allocation.lines.every((line) => line.complete);
  const singleCard = order.admission.methods.length === 1 && method.kind === 'card' && link.tender === 0
    && link.amountMinor === allocation.fullPriceMinor && allAttributed;
  if (!singleCard) return { provable: false, reason: 'parts-unprovable' };
  const parts = allocation.lines.map((line) => ({
    kind: line.metal ? 'precious-metals' as const : 'other' as const,
    metals: line.metal ? metalsOf(order, [line.ordinal]) : [],
    amountMinor: line.totalMinor,
  }));
  if (parts.reduce((total, part) => total + part.amountMinor, 0) !== link.amountMinor) return { provable: false, reason: 'parts-unprovable' };
  return { provable: true, basis: 'single-card-full-price', parts };
}
