import type { Database } from 'better-sqlite3';
import type { MetalsLine, MetalsOrder, MetalsSource } from '@finance-tracker/shared/metals-ledger';

import { canonicalJson } from './versions.js';

/**
 * The read projection of an order's active version (`metals_orders` and its lots, lot events, tenders, card evidence,
 * dispositions and payouts), rewritten whole for one order inside the transaction that changes its active version.
 */

const CONTENT_COLUMNS = 'title, product_ref, metal, metal_uncertain_guard, metal_uncertain_evidence, metal_uncertain_metal, form, '
  + 'stated_mass_value, stated_mass_unit, pack, purity_text, purity_value, mass_basis, design, content_fingerprint, fine_troy_oz, fine_basis, '
  + 'content_hold, content_missing, quantity, unit_price_minor';
const params = (count: number) => new Array(count).fill('?').join(', ');
const flag = (value: boolean) => (value ? 1 : 0);

/** A line's content values, in CONTENT_COLUMNS order. A flagged line keeps its flag whole: guard, evidence and metal. */
function contentValues(line: MetalsLine): unknown[] {
  const fine = line.fine;
  const known = 'troyOz' in fine;
  const uncertain = line.metalUncertain;
  return [
    line.title, line.productRef, line.metal, uncertain?.guard ?? null, uncertain === null ? null : canonicalJson(uncertain.evidence),
    uncertain?.metal ?? null, line.form, line.statedMass?.value ?? null, line.statedMass?.unit ?? null, line.pack,
    line.purity?.text ?? null, line.purity?.value ?? null, line.massBasis, line.design, line.contentFingerprint,
    known ? fine.troyOz : null, known ? fine.basis : null, known ? null : fine.hold, known ? null : canonicalJson(fine.missing),
    line.quantity, line.unitPriceMinor,
  ];
}

const shareOf = (line: MetalsLine, component: string) =>
  line.allocated.filter((share) => share.component === component).reduce((sum, share) => sum + share.amountMinor, 0);

/** Removes one order's projection rows, children first. */
export function deleteMetalsProjection(db: Database, orderKey: string): void {
  db.prepare('DELETE FROM metals_lot_events WHERE lot_key IN (SELECT lot_key FROM metals_lots WHERE order_key = ?)').run(orderKey);
  for (const table of ['metals_lots', 'metals_card_evidence', 'metals_tenders', 'metals_dispositions', 'metals_payouts', 'metals_orders']) {
    db.prepare(`DELETE FROM ${table} WHERE order_key = ?`).run(orderKey);
  }
}

/**
 * Whether another order's projection already holds one of this order's line or payout keys. Keys come from native ids
 * and belong to one order, so this is a converter fault; the plan refuses it before any write instead of letting the
 * projection's keys abort the transaction.
 */
export function metalsProjectionClashes(db: Database, order: MetalsOrder): boolean {
  const lineOwners = db.prepare(`SELECT order_key FROM metals_lots WHERE lot_key = ?
    UNION ALL SELECT order_key FROM metals_dispositions WHERE line_key = ?`).pluck();
  const payoutOwners = db.prepare('SELECT order_key FROM metals_payouts WHERE payout_key = ?').pluck();
  return order.lines.some((line) => (lineOwners.all(line.key, line.key) as string[]).some((owner) => owner !== order.key))
    || order.payouts.some((payout) => (payoutOwners.all(payout.key) as string[]).some((owner) => owner !== order.key));
}

/** Writes the projection of a canonical order, the active `version` of its key, created by an import of `accountId`. */
export function writeMetalsProjection(db: Database, order: MetalsOrder, version: number, accountId: string, source: MetalsSource): void {
  const admission = order.admission;
  const shipments = admission && admission.fulfilment !== 'in-store' ? admission.fulfilment.shipments : null;
  db.prepare(`INSERT INTO metals_orders (order_key, version, account_id, source, side, channel, order_date, trade_moment, completed_date, currency,
      status, fulfilment, shipments, refunded, cancelled, partly_cancelled, gross_total_minor, full_price_minor, unattributed_minor, skeleton_json,
      components_json, refunds_json) VALUES (${params(22)})`)
    .run(order.key, version, accountId, source, order.side, order.channel, order.date,
      order.tradeMoment === null ? null : new Date(order.tradeMoment).toISOString(), order.completedDate, order.currency, order.status,
      admission === null ? null : admission.fulfilment === 'in-store' ? 'in-store' : 'shipments', shipments,
      admission === null ? null : flag(admission.refunded), admission === null ? null : flag(admission.cancelled),
      admission === null ? null : flag(admission.partlyCancelled), admission === null ? null : admission.grossTotalMinor,
      order.fullPriceMinor, order.unattributedMinor, canonicalJson(order.skeleton), canonicalJson(order.components), canonicalJson(order.refunds));
  const tender = db.prepare('INSERT INTO metals_tenders (order_key, seq, kind, network, last4, amount_minor) VALUES (?, ?, ?, ?, ?, ?)');
  admission?.methods.forEach((method, seq) => tender.run(order.key, seq, method.kind, method.network, method.last4, method.amountMinor));
  const evidence = db.prepare('INSERT INTO metals_card_evidence (order_key, seq, evidence_class, tender_seq, amount_minor) VALUES (?, ?, ?, ?, ?)');
  order.evidence.forEach((entry, seq) => evidence.run(order.key, seq, entry.class, entry.tender, entry.amountMinor));
  if (order.side === 'buy') {
    const lot = db.prepare(`INSERT INTO metals_lots (lot_key, order_key, ordinal, ${CONTENT_COLUMNS}, amount_minor, direct_minor, allocated_json,
      cost_minor, cost_complete, seller) VALUES (${params(30)})`);
    const event = db.prepare(`INSERT INTO metals_lot_events (lot_key, seq, kind, event_date, date_basis, quantity, occurrence)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const line of order.lines) {
      lot.run(line.key, order.key, line.ordinal, ...contentValues(line), line.amountMinor, line.directMinor, canonicalJson(line.allocated),
        line.costMinor, flag(line.complete), line.seller);
      line.events.forEach((entry, seq) => event.run(line.key, seq, entry.kind, entry.date, entry.dateBasis, entry.quantity, entry.occurrence));
    }
  } else {
    const disposition = db.prepare(`INSERT INTO metals_dispositions (line_key, order_key, ordinal, kind, ${CONTENT_COLUMNS}, gross_minor,
      direct_minor, allocated_json, platform_fee_minor, insured_shipping_minor, net_minor, net_complete, program, premium_text, premium_basis,
      inspection, events_json) VALUES (${params(37)})`);
    for (const line of order.lines) {
      disposition.run(line.key, order.key, line.ordinal, 'sale', ...contentValues(line), line.amountMinor, line.directMinor,
        canonicalJson(line.allocated), shareOf(line, 'platform-fee'), shareOf(line, 'insured-shipping'), line.netMinor, flag(line.complete),
        line.sale?.program ?? null, line.sale?.premium?.text ?? null, line.sale?.premium?.basis ?? null, line.sale?.inspection ?? null,
        canonicalJson(line.events));
    }
  }
  const payout = db.prepare(`INSERT INTO metals_payouts (payout_key, order_key, method, destination_last4, amount_minor, initiated_date,
    payout_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of order.payouts) {
    payout.run(entry.key, order.key, entry.method, entry.destinationLast4, entry.amountMinor, entry.initiatedDate, entry.payoutDate, entry.status);
  }
}
