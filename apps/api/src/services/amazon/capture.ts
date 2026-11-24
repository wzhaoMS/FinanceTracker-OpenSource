import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { day, exact, refuse } from './policy.js';
import type { OrderObservation, RefundEvidencePhrase, Staging } from './types.js';
import { singleCardProven } from './tender.js';
import { validImageId, validTitle } from './products.js';
import { emptyOrderDetails, itemBlockReconciles, type OrderObservationScope } from './allocation.js';
import type { FreshSection } from './freshImport.js';

/** `fresh`: the capture's Amazon Fresh Item Lists, only ever about orders its staging holds. */
export interface ValidatedCapture { structure: unknown; staging: Staging; fresh?: FreshSection }
/**
 * The conflict sources that only say the reader could not read the tender: an unknown summary label, a held summary or
 * an unread method block. The producer treats exactly these as no contradiction (amazon-capture.mjs
 * `amazonProofHeaderConflict`), and its diagnostics list every source behind a tender conflict, so a conflict whose
 * sources are all among them contradicts nothing (Root, 2026-11-22).
 */
export const UNREAD_TENDER_SOURCES: readonly string[] = Object.freeze(['unknown-label', 'summary-hold', 'method-incomplete']);
/**
 * Called only after the full producer envelope has passed validation. No cursor metadata is retained. `tender-unread`:
 * an order whose explicit tender conflict its capture attributes only to unread tender (UNREAD_TENDER_SOURCES).
 */
export function orderObservationScope(structure: unknown, order: OrderObservation, ordinal: number): OrderObservationScope {
  const report = structure as {
    version?: number;
    itemDiagnostics?: { orders: Array<{ ordinal: number; observed: boolean }> };
    tenderDiagnostics?: { orders: Array<{ ordinal: number; gates?: unknown;
      proof?: { summary: { observed: boolean }; conflicts: string[] } }> };
  };
  if (report.version !== 3) return 'legacy';
  const item = report.itemDiagnostics?.orders.find(o => o.ordinal === ordinal);
  const tender = report.tenderDiagnostics?.orders.find(o => o.ordinal === ordinal);
  const summaryObserved = tender?.proof?.summary.observed;
  if (item?.observed === false && summaryObserved === false && !tender?.gates
    && tender?.proof?.conflicts.every(reason => ['summary-hold', 'method-incomplete'].includes(reason))
    && emptyOrderDetails(order)) return 'header-only';
  const sources = tender?.proof?.conflicts;
  if (order.tenderProof?.conflict && sources?.length
    && sources.every(reason => UNREAD_TENDER_SOURCES.includes(reason))) return 'tender-unread';
  return 'legacy';
}
const keys = ['format', 'version', 'source', 'window', 'coverage', 'resume', 'orders', 'payments'];
const positive = (v: unknown): v is number => typeof v === 'number' && v > 0;
const count = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
/** Each closed phrase fixes its record's kind and status (mirrors the producer's `rules.refunds.phrases`). */
export const REFUND_PHRASES: Readonly<Record<RefundEvidencePhrase, readonly ['refund' | 'return', string]>> = Object.freeze({
  'return-created': ['return', 'started'], 'return-started': ['return', 'started'],
  'return-requested': ['return', 'started'], 'return-in-transit': ['return', 'in-transit'],
  'return-received': ['return', 'received'], 'return-complete': ['return', 'completed'],
  'return-cancelled': ['return', 'cancelled'], 'refund-issued': ['refund', 'completed'],
  'refund-complete': ['refund', 'completed'], 'refund-processed': ['refund', 'completed'],
  refunded: ['refund', 'completed'], 'refund-for-return': ['refund', 'pending'], 'refund-pending': ['refund', 'pending'],
});
const positiveUsd = (value: unknown): boolean => {
  const m = exact(value, ['currency', 'amountMinor']);
  return m.currency === 'USD' && Number.isSafeInteger(m.amountMinor) && Number(m.amountMinor) > 0 && Number(m.amountMinor) <= 100000000;
};
/** Exact type and value: a wrapped value (array, object, null) never coerces into an allowed string. */
const oneOf = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value);
const knownMethod = (value: unknown): boolean => {
  const m = exact(value, ['kind', 'network', 'last4']);
  return oneOf(m.kind, ['card', 'balance', 'points'])
    && oneOf(m.network, ['visa', 'mastercard', 'amex', 'discover', 'unknown'])
    && (m.last4 === null || (m.kind === 'card' && typeof m.last4 === 'string' && /^\d{4}$/.test(m.last4)))
    && (m.kind === 'card' || m.network === 'unknown');
};
/** A return never carries refund money; order-details lines must be that capture's own staged lines. */
export function validateRefundEvidence(value: unknown, orders: unknown[], window: Record<string, unknown>): void {
  if (!Array.isArray(value) || value.length > 800 || typeof window.from !== 'string' || !day(window.from)
    || typeof window.through !== 'string' || !day(window.through)) return refuse();
  const from = window.from, through = window.through;
  const staged = new Map((orders as OrderObservation[]).map(o => [o.orderId, o]));
  const occurrences = new Set<string>();
  for (const entry of value) {
    const r = exact(entry, ['kind', 'status', 'date', 'money', 'orderIds', 'destinations', 'items', 'provenance']);
    const p = exact(r.provenance, ['source', 'page', 'ordinal', 'phrase']);
    if (!oneOf(p.source, ['order-details', 'returns-page']) || !count(p.page, 47) || !count(p.ordinal, 799)
      || typeof p.phrase !== 'string' || !Object.hasOwn(REFUND_PHRASES, p.phrase)) return refuse();
    const phrase = REFUND_PHRASES[p.phrase as RefundEvidencePhrase];
    const occurrence = `${p.source}:${p.page}:${p.ordinal}`;
    if (phrase[0] !== r.kind || phrase[1] !== r.status || occurrences.has(occurrence)
      || !Array.isArray(r.orderIds) || r.orderIds.length !== 1 || typeof r.orderIds[0] !== 'string'
      || !/^\d{3}-\d{7}-\d{7}$/.test(r.orderIds[0])
      || (r.date !== null && (!day(r.date) || r.date < from || r.date > through))
      || !Array.isArray(r.destinations) || r.destinations.length > 4 || !Array.isArray(r.items) || r.items.length > 100) return refuse();
    occurrences.add(occurrence);
    if (r.kind === 'return') {
      if (r.money !== null || r.destinations.length) return refuse();
    } else {
      // Only a completed refund states money, a date or destinations: a pending one is expected, never executed.
      if (r.status !== 'completed' && (r.money !== null || r.date !== null || r.destinations.length)) return refuse();
      if (r.money !== null && !positiveUsd(r.money)) return refuse();
      const methods = new Set<string>();
      let stated = 0, all = true;
      for (const value of r.destinations) {
        const d = exact(value, ['method', 'money']);
        if (!knownMethod(d.method) || methods.has(JSON.stringify(d.method))) return refuse();
        methods.add(JSON.stringify(d.method));
        if (d.money === null) all = false;
        else if (!positiveUsd(d.money)) return refuse();
        else stated += Number((d.money as Record<string, unknown>).amountMinor);
      }
      const total = r.money === null ? null : Number((r.money as Record<string, unknown>).amountMinor);
      if ((total === null && stated > 0) || (total !== null && (stated > total || (all && r.destinations.length && stated !== total)))) {
        return refuse();
      }
    }
    const order = staged.get(r.orderIds[0]);
    // A Returns-page return is dated by its created date; its refund may not show one.
    if (p.source === 'order-details' ? !order : (r.kind === 'return' && r.date === null)) return refuse();
    const lines = new Set<number>();
    for (const value of r.items) {
      const i = exact(value, ['lineOrdinal', 'itemId', 'title', 'units']);
      if ((i.itemId !== null && (typeof i.itemId !== 'string' || !/^[A-Z0-9]{10}$/.test(i.itemId)))
        || (i.title !== null && !validTitle(i.title)) || (i.units !== null && (!count(i.units, 999) || i.units === 0))) return refuse();
      if (p.source === 'order-details') {
        const line = order!.items.find(l => l.lineOrdinal === i.lineOrdinal);
        if (!count(i.lineOrdinal, 99) || !line || lines.has(i.lineOrdinal) || i.itemId !== line.itemId || i.title !== null) return refuse();
        lines.add(i.lineOrdinal);
      } else if (i.lineOrdinal !== null || (i.itemId === null && i.title === null)) return refuse();
    }
  }
}
function validateV3(staging: Record<string, unknown>): unknown {
  exact(staging, [...keys, 'runId', ...(Object.hasOwn(staging, 'mode') ? ['mode'] : []),
    ...(Object.hasOwn(staging, 'refundEvidence') ? ['refundEvidence'] : [])]);
  if (Object.hasOwn(staging, 'mode') && (typeof staging.mode !== 'string' || !['recent', 'backfill'].includes(staging.mode))) return refuse();
  if (typeof staging.runId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(staging.runId)
    || !Array.isArray(staging.orders) || !Array.isArray(staging.payments)) return refuse();
  const orders = staging.orders.map((value: unknown) => {
    const optionalProof = value && typeof value === 'object' && Object.hasOwn(value, 'itemProof');
    const order = exact(value, ['orderId', 'date', 'total', 'items', 'paymentCoverage', 'paymentMethods', 'summary',
      'tenderCoverage', 'tenderProof', ...(optionalProof ? ['itemProof'] : []),
      ...(value && typeof value === 'object' && Object.hasOwn(value, 'refundSummary') ? ['refundSummary'] : []),
      ...(value && typeof value === 'object' && Object.hasOwn(value, 'chargeFree') ? ['chargeFree'] : [])]);
    if (Object.hasOwn(order, 'refundSummary')) {
      const refund = exact(order.refundSummary, ['currency', 'amountMinor']);
      if (refund.currency !== 'USD' || !Number.isSafeInteger(refund.amountMinor)
        || Number(refund.amountMinor) < 0 || Number(refund.amountMinor) > 100000000) return refuse();
    }
    if (optionalProof) {
      const p = exact(order.itemProof, ['complete', 'unknownLine', 'conflict']);
      if (typeof p.complete !== 'boolean'
        || typeof p.unknownLine !== 'boolean' || typeof p.conflict !== 'boolean'
        || (p.complete && (p.unknownLine || p.conflict || !Array.isArray(order.items)
          || order.items.length === 0))) return refuse();
    }
    const proof = exact(order.tenderProof, ['methodComplete', 'summaryComplete', 'unknownMethod', 'unknownSummary', 'conflict']);
    if (Object.values(proof).some(v => typeof v !== 'boolean')) return refuse();
    if (!Array.isArray(order.paymentMethods) || order.paymentMethods.length > 8 || !Array.isArray(order.summary)
      || order.summary.length > 8 || !Array.isArray(order.items) || typeof order.tenderCoverage !== 'string'
      || !['single-card-proven', 'multi-tender', 'unknown'].includes(order.tenderCoverage)) return refuse();
    const summaryKinds = new Set();
    for (const entry of order.summary) {
      const s = exact(entry, ['kind', 'money']);
      if (typeof s.kind !== 'string'
        || !['items-subtotal', 'shipping', 'tax', 'tip', 'gift-card', 'promotion', 'rewards', 'grand-total'].includes(s.kind)
        || summaryKinds.has(s.kind)) return refuse();
      summaryKinds.add(s.kind);
      const m = exact(s.money, ['currency', 'amountMinor']);
      if (m.currency !== 'USD' || !Number.isSafeInteger(m.amountMinor) || Math.abs(Number(m.amountMinor)) > 100000000) return refuse();
      if (s.kind === 'grand-total' && order.total !== null
        && JSON.stringify(s.money) !== JSON.stringify(order.total)) {
        // Compare values, not property ordering.
        const t = exact(order.total, ['currency', 'amountMinor']);
        if (m.currency !== t.currency || m.amountMinor !== t.amountMinor) return refuse();
      }
    }
    const methods = order.paymentMethods.map((value: unknown) => {
      const m = exact(value, ['kind', 'network', 'last4']);
      if (typeof m.kind !== 'string' || !['card', 'balance', 'points', 'unknown'].includes(m.kind)
        || typeof m.network !== 'string' || !['visa', 'mastercard', 'amex', 'discover', 'unknown'].includes(m.network)
        || (m.last4 !== null && (m.kind !== 'card' || typeof m.last4 !== 'string' || !/^\d{4}$/.test(m.last4)))
        || (m.kind !== 'card' && m.network !== 'unknown')) return refuse();
      return m;
    });
    if (order.tenderCoverage === 'single-card-proven' && (methods.length !== 1 || methods[0].kind !== 'card'
      || methods[0].network === 'unknown' || methods[0].last4 === null || !summaryKinds.has('grand-total')
      || order.total === null || !positive(exact(order.total, ['currency', 'amountMinor']).amountMinor)
      || order.summary.some((entry: Record<string, unknown>) => (entry.kind === 'gift-card' || entry.kind === 'rewards')
        && (entry.money as Record<string, unknown>).amountMinor !== 0))) return refuse();
    // charge-free proof (#158): a closed positive no-charge status, only on an empty-details order with no total.
    if (Object.hasOwn(order, 'chargeFree')) {
      const proof = exact(order.chargeFree, ['status', 'shipments']);
      if (proof.status !== 'cancelled-not-charged' || !count(proof.shipments, 100) || Number(proof.shipments) < 1
        || order.total !== null || !emptyOrderDetails(order as unknown as OrderObservation)) return refuse();
    }
    const ordinals = new Set();
    const items = order.items.map((item: unknown) => {
      const image = !!item && typeof item === 'object' && Object.hasOwn(item, 'imageId');
      const i = exact(item, ['lineOrdinal', 'itemId', 'title', 'quantity', 'unitPrice', ...(image ? ['imageId'] : [])]);
      if (!count(i.lineOrdinal, 99) || ordinals.has(i.lineOrdinal) || !validTitle(i.title)
        || (image && !validImageId(i.imageId))) return refuse();
      ordinals.add(i.lineOrdinal);
      const { lineOrdinal: _ordinal, imageId: _imageId, ...legacy } = i;
      // v2 has a smaller title bound; validate v3 text above without changing any financial field.
      return { ...legacy, title: 'Validated product title' };
    });
    return { orderId: order.orderId, date: order.date, total: order.total, items, paymentCoverage: order.paymentCoverage };
  });
  const occurrences = new Set();
  const payments = staging.payments.map((value: unknown) => {
    const p = exact(value, ['date', 'money', 'kind', 'status', 'method', 'orderIds', 'identity', 'provenance']);
    const source = exact(p.provenance, ['source', 'status', 'page', 'ordinal']);
    if (source.source !== 'ledger' || !count(source.page, 47) || !count(source.ordinal, 799)
      || typeof source.status !== 'string' || !['Charged', 'Refunded', 'Pending'].includes(source.status)) return refuse();
    const occurrence = `${source.page}:${source.ordinal}`;
    if (occurrences.has(occurrence)) return refuse();
    occurrences.add(occurrence);
    const expected = source.status === 'Charged' ? ['charge', 'completed']
      : source.status === 'Refunded' ? ['refund', 'completed'] : ['unknown', 'pending'];
    if (p.kind !== expected[0] || p.status !== expected[1]) return refuse();
    const { provenance: _provenance, ...legacy } = p;
    return legacy;
  });
  // After the orders above, so order-details lines are checked against validated staged lines.
  if (Object.hasOwn(staging, 'refundEvidence')) {
    validateRefundEvidence(staging.refundEvidence, staging.orders, exact(staging.window, ['from', 'through', 'timeZone']));
  }
  const { runId: _runId, refundEvidence: _evidence, ...legacy } = staging;
  return { ...legacy, version: 2, orders, payments };
}
/** The producer's closed schema validates the original version, including cross-boundary diagnostics. */
export async function validateCapture(value: unknown): Promise<ValidatedCapture> {
  try {
    const hasContinuation = value && typeof value === 'object' && Object.hasOwn(value, 'continuation');
    const hasFresh = value && typeof value === 'object' && Object.hasOwn(value, 'fresh');
    const capture = exact(value, ['structure', 'staging', ...(hasContinuation ? ['continuation'] : []), ...(hasFresh ? ['fresh'] : [])]);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2 * 1024 * 1024) return refuse();
    const staging = capture.staging;
    if (!staging || typeof staging !== 'object' || Array.isArray(staging)) return refuse();
    const record = staging as Record<string, unknown>;
    if (record.version === 3) validateV3(record);
    const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', '..', '..', 'tools', 'amazon-capture', 'amazon-capture.mjs')).href;
    const producer = await import(moduleUrl);
    const validate: unknown = producer.validateAmazonCapture;
    if (typeof validate !== 'function') return refuse();
    validate(value);
    if (record.version === 3) {
      for (const order of (value as ValidatedCapture).staging.orders) {
        if (order.tenderCoverage === 'single-card-proven' && !singleCardProven(order)) return refuse();
        if (order.itemProof?.complete && !itemBlockReconciles(order)) return refuse();
      }
    }
    return { structure: capture.structure, staging: (value as ValidatedCapture).staging,
      ...(hasFresh ? { fresh: capture.fresh as FreshSection } : {}) };
  } catch {
    // Validation/import errors may include private input or local paths. Never retain the foreign exception.
    return refuse();
  }
}
