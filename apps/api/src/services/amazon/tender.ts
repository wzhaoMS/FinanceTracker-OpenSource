import { minor } from './policy.js';
import type { OrderObservation } from './types.js';

/** Positive block completeness plus exact typed arithmetic; CARD4 + Grand Total alone is insufficient. */
export function singleCardProven(order: OrderObservation): boolean {
  const proof = order.tenderProof;
  if (!proof?.methodComplete || !proof.summaryComplete || proof.unknownMethod || proof.unknownSummary || proof.conflict
    || order.paymentMethods?.length !== 1 || !order.total || !minor(order.total.amountMinor) || order.total.amountMinor <= 0) return false;
  const method = order.paymentMethods[0];
  if (method.kind !== 'card' || method.network === 'unknown' || !method.last4 || !/^\d{4}$/.test(method.last4)) return false;
  const summary = order.summary ?? [];
  // A Fresh order's driver tip is part of what the card paid, never an item's cost (allocation leaves it whole-row).
  const allowed = new Set(['items-subtotal', 'shipping', 'tax', 'tip', 'promotion', 'grand-total']);
  if (new Set(summary.map(s => s.kind)).size !== summary.length
    || summary.some(s => !allowed.has(s.kind) || !minor(s.money.amountMinor) || s.money.amountMinor < 0
      || s.money.currency !== order.total!.currency)) return false;
  const components = new Map(summary.map(s => [s.kind, s.money.amountMinor]));
  const required = ['items-subtotal', 'shipping', 'tax', 'grand-total'] as const;
  if (required.some(k => !components.has(k))) return false;
  if (components.has('gift-card') || components.has('rewards')
    || components.get('grand-total') !== order.total.amountMinor) return false;
  return BigInt(components.get('items-subtotal')!) + BigInt(components.get('shipping')!) + BigInt(components.get('tax')!)
    + BigInt(components.get('tip') ?? 0) - BigInt(components.get('promotion') ?? 0) === BigInt(order.total.amountMinor);
}
