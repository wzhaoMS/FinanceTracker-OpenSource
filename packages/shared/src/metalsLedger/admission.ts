/**
 * Card-evidence admission (design v8 §4.4.4, part of `METALS_CARD_LINK_RULE` v1): whether an order's card funding
 * settles in one charge under its source's named, versioned evidence class, recomputed from the order's admission
 * facts alone. The binding is checked later, when read; admission is "binding aside".
 *
 * - `costco-settled-tender@1`: a warehouse receipt (each card tender is one charge at the register), or an online order
 *   with exactly one card tender whose shipment records, counted order-wide, number exactly one. Zero or missing
 *   shipment evidence, or more than one record, is an aggregate.
 * - `walmart-order-total@1`: an online order with exactly one payment method, a card, whose stated total is the grand
 *   total, and exactly one shipment group.
 * - Both: not refunded, not cancelled, not partly cancelled; every method's amount stated, none negative, positive for a
 *   card, and all of them adding up to the order's gross total; no card refund among them.
 *
 * Anything else with card funding is an aggregate, which bars card rows up to its gross total (any amount when the
 * gross total is unknown, or when the funding contradicts itself: a credit among the methods, or a card stated above
 * the gross total, since a charge may then exceed it). An order with no card funding is neither a subject nor a
 * competitor. A gross total before refunds is never negative: a credit funds no order.
 *
 * Pure: no file system, network or clock.
 */

import {
  METALS_SETTLEMENT_WINDOW_DAYS,
  type MetalsAdmissionFacts,
  type MetalsCardEvidence,
  type MetalsChannel,
  type MetalsCompetitorBasis,
  type MetalsSource,
} from './model.js';

export interface MetalsAdmission {
  basis: MetalsCompetitorBasis;
  /** An aggregate's gross total, the most it bars (null: any amount); null for a single charge. */
  capMinor: number | null;
  /** A single charge's card evidence, one per card method in method order; none for an aggregate. */
  evidence: MetalsCardEvidence[];
}

/** The order's admission, or null when it has no card funding at all. Sales have no card funding. */
export function metalsAdmission(source: MetalsSource, channel: MetalsChannel, facts: MetalsAdmissionFacts): MetalsAdmission | null {
  if (facts.grossTotalMinor !== null && facts.grossTotalMinor < 0) {
    throw new RangeError('metalsAdmission: a gross total before refunds is never negative');
  }
  const cards = facts.methods.flatMap((method, index) => (method.kind === 'card' || method.kind === 'card-refund' ? [{ method, index }] : []));
  if (source === 'collectpure' || cards.length === 0) return null;
  // Funding that contradicts itself, a credit among the methods (a negative amount on anything but a card refund) or a
  // card stated above the gross total, means some card charge may exceed the gross total: the barrier covers any amount.
  const gross = facts.grossTotalMinor;
  const contradictory = facts.methods.some((method) => method.kind !== 'card-refund' && method.amountMinor !== null && method.amountMinor < 0)
    || (gross !== null && cards.some(({ method }) => method.kind === 'card' && method.amountMinor !== null && method.amountMinor > gross));
  if (contradictory) return { basis: 'aggregate', capMinor: null, evidence: [] };
  const aggregate: MetalsAdmission = { basis: 'aggregate', capMinor: gross, evidence: [] };
  if (facts.refunded || facts.cancelled || facts.partlyCancelled || gross === null) return aggregate;
  if (cards.some(({ method }) => method.kind !== 'card' || method.amountMinor === null || method.amountMinor <= 0)) return aggregate;
  if (facts.methods.some((method) => method.amountMinor === null)) return aggregate;
  const total = facts.methods.reduce((sum, method) => sum + method.amountMinor!, 0);
  if (total !== gross) return aggregate;
  const shipments = facts.fulfilment === 'in-store' ? null : facts.fulfilment.shipments;
  const single = (evidenceClass: MetalsCardEvidence['class']): MetalsAdmission => ({
    basis: 'single-charge',
    capMinor: null,
    evidence: cards.map(({ method, index }) => ({ class: evidenceClass, tender: index, amountMinor: method.amountMinor! })),
  });
  if (source === 'costco') {
    if (channel === 'warehouse') return facts.fulfilment === 'in-store' ? single('costco-settled-tender@1') : aggregate;
    return shipments === 1 && cards.length === 1 ? single('costco-settled-tender@1') : aggregate;
  }
  return channel === 'online' && shipments === 1 && facts.methods.length === 1 ? single('walmart-order-total@1') : aggregate;
}

const DAY_MS = 86_400_000;

/** A record's settlement interval: its date through date + the channel's window, both ends inclusive. */
export function metalsSettlementInterval(date: string, channel: MetalsChannel): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start)) throw new RangeError('metalsSettlementInterval: not a date');
  return { from: date, to: new Date(start + METALS_SETTLEMENT_WINDOW_DAYS[channel] * DAY_MS).toISOString().slice(0, 10) };
}
