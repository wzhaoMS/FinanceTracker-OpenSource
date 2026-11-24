import type Database from 'better-sqlite3';
import type { RetailImportReceipt } from '@finance-tracker/shared/retail-import-payload';

import { newRetailId } from './common.js';
import { RETAIL_LINE_EVENT_KINDS } from './schema.js';
import {
  RETAIL_TOTAL_KEYS,
  retailLineIdentity,
  retailOccurrences,
  retailShipmentObservation,
  retailTenderMoneyKey,
  retailTenderObservation,
  type RetailLineMoney,
  type RetailVersionComparable,
  type RetailVersionLabels,
} from './versions.js';

/**
 * Stable logical identities (plan v5 §4.3, Q-L1, D-R3-4) and a version's immutable facts (§4.2, Q-S1).
 *
 * - A receipt is one `rcp-…` per (merchant, natural key), for life.
 * - A line ref is allocated the first time a receipt shows that source line: online by its line key, warehouse and gas by
 *   its ordinal; every later version showing the same key or ordinal uses it. Nothing is matched by title, amount or
 *   product.
 * - Shipments and tenders carry no native identity, so a ref names one distinct observation (its facts) and its
 *   occurrence among identical ones, never a position: the very same observation keeps its ref, anything else gets a new
 *   one, and an old ref is never re-matched to another observation by position, date, kind or amount.
 * - A version's facts are rows keyed by (version, ref): facts of different versions never mix.
 * Every ref is random, from `newRetailId`.
 */

/** A stored receipt as an import or a review meets it. */
export interface RetailStoredReceipt {
  receiptRef: string;
  channel: string;
  state: 'active' | 'quarantined';
  firstReason: string | null;
  canonicalVersion: string;
  selectionSeq: number;
}

const RECEIPT_COLUMNS = `receipt_ref AS receiptRef, channel, state, first_reason AS firstReason, canonical_version AS canonicalVersion,
  selection_seq AS selectionSeq`;

/** The receipt of a natural key, or null. */
export function retailReceiptByKey(db: Database.Database, naturalKey: string): RetailStoredReceipt | null {
  return (db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM retail_receipts WHERE merchant = 'costco' AND natural_key = ?`)
    .get(naturalKey) as RetailStoredReceipt | undefined) ?? null;
}

/** The receipt of a ref, or null. */
export function retailReceiptByRef(db: Database.Database, receiptRef: string): RetailStoredReceipt | null {
  return (db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM retail_receipts WHERE receipt_ref = ?`).get(receiptRef) as RetailStoredReceipt | undefined) ?? null;
}

/** The stored version of a receipt with exactly these three digests, or null. */
export function retailVersionByDigests(db: Database.Database, receiptRef: string,
  digests: Pick<RetailVersionComparable, 'sourceDigest' | 'meaningDigest' | 'provenanceDigest'>): string | null {
  return (db.prepare(`SELECT version_ref FROM retail_receipt_versions WHERE receipt_ref = ? AND source_digest = ? AND meaning_digest = ?
    AND provenance_digest = ?`).pluck().get(receiptRef, digests.sourceDigest, digests.meaningDigest, digests.provenanceDigest) as string | undefined) ?? null;
}

interface VersionRow {
  sourceDigest: string;
  meaningDigest: string;
  provenanceDigest: string;
  policyVersion: number;
  sign: string;
  currency: string;
}

const TOTAL_COLUMNS = ['subtotal_minor', 'tax_minor', 'instant_savings_minor', 'discount_minor', 'shipping_minor', 'fees_minor',
  'stored_value_minor', 'total_minor'] as const;

/**
 * A stored version as a sighting is compared with it (plan §5.2): its digests, its policy and its money read from its own
 * fact rows, not from its digests, so a version whose facts and digests disagree still shows a money difference.
 */
export function retailStoredVersion(db: Database.Database, versionRef: string): RetailVersionComparable {
  const row = db.prepare(`SELECT source_digest AS sourceDigest, meaning_digest AS meaningDigest, provenance_digest AS provenanceDigest,
      policy_version AS policyVersion, sign, currency, ${TOTAL_COLUMNS.join(', ')} FROM retail_receipt_versions WHERE version_ref = ?`)
    .get(versionRef) as (VersionRow & Record<(typeof TOTAL_COLUMNS)[number], number | null>) | undefined;
  if (row === undefined) throw new TypeError('a retail receipt names a version that is not stored');
  const lines = db.prepare(`SELECT l.line_key AS lineKey, f.ordinal AS ordinal, f.amount_minor AS amountMinor, f.unit_price_minor AS unitPriceMinor,
      f.shipping_minor AS shippingMinor FROM retail_line_facts f JOIN retail_line_refs l ON l.line_ref = f.line_ref WHERE f.version_ref = ?`)
    .all(versionRef) as Array<{ lineKey: string | null; ordinal: number } & RetailLineMoney>;
  const tenderRows = db.prepare(`SELECT kind, network, last4, amount_minor AS amountMinor FROM retail_tender_facts WHERE version_ref = ?`)
    .all(versionRef) as Array<{ kind: string; network: string; last4: string | null; amountMinor: number }>;
  const tenders = new Map<string, number>();
  for (const tender of tenderRows) tenders.set(retailTenderMoneyKey(tender), (tenders.get(retailTenderMoneyKey(tender)) ?? 0) + 1);
  return {
    sourceDigest: row.sourceDigest,
    meaningDigest: row.meaningDigest,
    provenanceDigest: row.provenanceDigest,
    policyVersion: row.policyVersion,
    money: {
      currency: row.currency,
      sign: row.sign,
      totals: TOTAL_COLUMNS.map((column) => row[column]),
      lines: new Map(lines.map((line) => [retailLineIdentity(line),
        { amountMinor: line.amountMinor, unitPriceMinor: line.unitPriceMinor, shippingMinor: line.shippingMinor }])),
      tenders,
    },
  };
}

/** Inserts a new receipt, unselected (its created event selects it, plan §4.2), and returns its ref. */
export function insertRetailReceipt(db: Database.Database, receipt: Pick<RetailImportReceipt, 'channel' | 'naturalKey'>, importId: string): string {
  const receiptRef = newRetailId('rcp-');
  db.prepare(`INSERT INTO retail_receipts (receipt_ref, merchant, channel, natural_key, first_import, state, first_reason, canonical_version,
    selection_seq) VALUES (?, 'costco', ?, ?, ?, 'active', NULL, NULL, 0)`).run(receiptRef, receipt.channel, receipt.naturalKey, importId);
  return receiptRef;
}

function lineRef(db: Database.Database, receiptRef: string, line: { lineKey: string | null; ordinal: number }): string {
  const existing = (line.lineKey !== null
    ? db.prepare('SELECT line_ref FROM retail_line_refs WHERE receipt_ref = ? AND line_key = ?').pluck().get(receiptRef, line.lineKey)
    : db.prepare('SELECT line_ref FROM retail_line_refs WHERE receipt_ref = ? AND ordinal = ?').pluck().get(receiptRef, line.ordinal)) as string | undefined;
  if (existing !== undefined) return existing;
  const ref = newRetailId('rli-');
  db.prepare('INSERT INTO retail_line_refs (line_ref, receipt_ref, line_key, ordinal) VALUES (?, ?, ?, ?)')
    .run(ref, receiptRef, line.lineKey, line.lineKey === null ? line.ordinal : null);
  return ref;
}

function shipmentRef(db: Database.Database, line: string, observation: string, occurrence: number): string {
  const existing = db.prepare('SELECT shipment_ref FROM retail_shipment_refs WHERE line_ref = ? AND observation_digest = ? AND occurrence = ?')
    .pluck().get(line, observation, occurrence) as string | undefined;
  if (existing !== undefined) return existing;
  const ref = newRetailId('shp-');
  db.prepare('INSERT INTO retail_shipment_refs (shipment_ref, line_ref, observation_digest, occurrence) VALUES (?, ?, ?, ?)')
    .run(ref, line, observation, occurrence);
  return ref;
}

function tenderRef(db: Database.Database, receiptRef: string, observation: string, occurrence: number): string {
  const existing = db.prepare('SELECT tender_ref FROM retail_tender_refs WHERE receipt_ref = ? AND observation_digest = ? AND occurrence = ?')
    .pluck().get(receiptRef, observation, occurrence) as string | undefined;
  if (existing !== undefined) return existing;
  const ref = newRetailId('rtn-');
  db.prepare('INSERT INTO retail_tender_refs (tender_ref, receipt_ref, observation_digest, occurrence) VALUES (?, ?, ?, ?)')
    .run(ref, receiptRef, observation, occurrence);
  return ref;
}

/**
 * Stores one new version of a receipt, once (Q-S1): the version row (its digests, labels and the receipt's facts), its tax
 * legends, and each line's facts, guard evidence, events and shipments, and each tender's facts, under the refs their
 * identities give (allocated on first sight). Returns the version's ref. The caller has checked that no stored version
 * of the receipt has the same three digests.
 */
export function storeRetailVersion(db: Database.Database, receiptRef: string, receipt: RetailImportReceipt, version: RetailVersionComparable,
  labels: RetailVersionLabels, importId: string): string {
  const versionRef = newRetailId('rrv-');
  const totals = RETAIL_TOTAL_KEYS.map((key) => receipt.totals[key]);
  db.prepare(`INSERT INTO retail_receipt_versions (version_ref, receipt_ref, source_digest, meaning_digest, provenance_digest, policy_version,
      title_rule, metal_guard, pack_rule, first_import, date, local_time, sign, status, currency, ${TOTAL_COLUMNS.join(', ')})
    VALUES (${new Array(15 + TOTAL_COLUMNS.length).fill('?').join(', ')})`)
    .run(versionRef, receiptRef, version.sourceDigest, version.meaningDigest, version.provenanceDigest, labels.policyVersion, labels.titleRule,
      labels.metalGuard, labels.packRule, importId, receipt.date, receipt.localTime, receipt.sign, receipt.status, receipt.currency, ...totals);
  const legend = db.prepare('INSERT INTO retail_tax_legends (version_ref, position, legend, amount_minor) VALUES (?, ?, ?, ?)');
  receipt.taxLegends.forEach((entry, position) => legend.run(versionRef, position, entry.legend, entry.amountMinor));

  const lineFact = db.prepare(`INSERT INTO retail_line_facts (version_ref, line_ref, ordinal, kind, item_number, title, title2, department, quantity,
      unit_price_minor, amount_minor, shipping_minor, tax_flag, coupon_target, fee_parent, fulfilment, stored_value, fuel_gallons, fuel_unit_price,
      metal_rule, metal, form, stated_weight_value, stated_weight_unit, pack, uncertain_guard, uncertain_metal)
    VALUES (${new Array(27).fill('?').join(', ')})`);
  const evidence = db.prepare('INSERT INTO retail_line_uncertain_evidence (version_ref, line_ref, position, evidence) VALUES (?, ?, ?, ?)');
  const lineEvent = db.prepare('INSERT INTO retail_line_events (version_ref, line_ref, event, position, quantity, date) VALUES (?, ?, ?, ?, ?, ?)');
  const shipmentFact = db.prepare(`INSERT INTO retail_shipment_facts (version_ref, shipment_ref, line_ref, position, shipped_date, delivered_date,
    estimated_arrival_date, carrier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const line of receipt.lines) {
    const ref = lineRef(db, receiptRef, line);
    const metal = line.metal;
    const uncertain = line.metalUncertain;
    lineFact.run(versionRef, ref, line.ordinal, line.kind, line.itemNumber, line.title, line.title2, line.department, line.quantity,
      line.unitPriceMinor, line.amountMinor, line.shippingMinor, line.taxFlag, line.couponTarget, line.feeParent, line.fulfilment, line.storedValue,
      line.fuelGallons, line.fuelUnitPrice, metal?.rule ?? null, metal?.metal ?? null, metal?.form ?? null, metal?.statedWeight?.value ?? null,
      metal?.statedWeight?.unit ?? null, metal?.pack ?? null, uncertain?.guard ?? null, uncertain?.metal ?? null);
    uncertain?.evidence.forEach((entry, position) => evidence.run(versionRef, ref, position, entry));
    if (line.events !== null) {
      for (const kind of RETAIL_LINE_EVENT_KINDS) {
        line.events[kind].forEach((event, position) => lineEvent.run(versionRef, ref, kind, position, event.quantity, event.date));
      }
    }
    const observations = line.shipments.map(retailShipmentObservation);
    const occurrences = retailOccurrences(observations);
    line.shipments.forEach((shipment, position) => {
      shipmentFact.run(versionRef, shipmentRef(db, ref, observations[position], occurrences[position]), ref, position, shipment.shippedDate,
        shipment.deliveredDate, shipment.estimatedArrivalDate, shipment.carrier);
    });
  }
  const tenderFact = db.prepare(`INSERT INTO retail_tender_facts (version_ref, tender_ref, ordinal, kind, network, last4, amount_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const observations = receipt.tenders.map(retailTenderObservation);
  const occurrences = retailOccurrences(observations);
  receipt.tenders.forEach((tender, index) => {
    tenderFact.run(versionRef, tenderRef(db, receiptRef, observations[index], occurrences[index]), tender.ordinal, tender.kind, tender.network,
      tender.last4, tender.amountMinor);
  });
  return versionRef;
}
