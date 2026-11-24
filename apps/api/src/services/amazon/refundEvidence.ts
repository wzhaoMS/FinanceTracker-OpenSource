import type { Database } from 'better-sqlite3';
import { digest, opaque } from './policy.js';
import { dedupeLedgerRefunds, type LedgerRefundObservation, type OrderRefundEvidence } from './refundAttribution.js';
import { REFUND_ISSUED_PHRASES, type PageRefundEvent, type PageRefundItem, type PageRefundSource } from './refundEventNetting.js';
import { isRefundEvidence } from './refundEvents.js';
import { hasRefundEventSchema } from './schema.js';
import type { ItemObservation, Money, PaymentObservation, RefundEvidence } from './types.js';

type LedgerExclusion = 'multiple-orders' | 'contradictory' | 'invalid' | 'ambiguous-repeat';
export interface OrderRefundEvidenceRead extends OrderRefundEvidence {
  /** The ledger observations behind `ledger`'s refunds, repeats across captures included. */
  ledgerObservations: number;
  /**
   * Its refund statements from order-details pages and the Returns page, issued or not, in import order
   * (refundEventNetting.ts); none until a guarded write has installed #155's event tables.
   */
  pageRefunds: PageRefundEvent[];
}
export interface RefundEvidenceRead {
  /** Per native order ID asked for (never shown): its Refund Total observations and its own ledger refunds. */
  byOrder: Map<string, OrderRefundEvidenceRead>;
  /**
   * Ledger refunds no single order can take, for any order asked for: several orders at once, contradictory, invalid;
   * and rows identical to another in their run beyond the one that counts.
   */
  excluded: Array<{ reason: LedgerExclusion; count: number }>;
}

/**
 * The refund evidence of some orders, read without writing: every observation of each order's Refund Total
 * (`refundSummary`) oldest first, and the payments ledger's completed `Refunded` refunds, each counted once
 * (dedupeLedgerRefunds). Only ledger rows are ledger evidence: other refund records in the same tables (from order
 * pages or returns pages) never are. Rows of v3 captures only: earlier ones carry no ledger provenance. Those page
 * records are read apart, as issued refund events (`pageRefunds`).
 */
export function readRefundEvidence(db: Database, orders: ReadonlyArray<{ ref: string; orderId: string }>): RefundEvidenceRead {
  const byOrder = new Map<string, OrderRefundEvidenceRead>(orders.map(o => [o.orderId,
    { summaries: [] as Money[], ledger: [] as Money[], ledgerObservations: 0, pageRefunds: [] as PageRefundEvent[] }]));
  const answer: RefundEvidenceRead = { byOrder, excluded: [] };
  if (!orders.length) return answer;
  const idByRef = new Map(orders.map(o => [o.ref, o.orderId]));
  const totals = db.prepare(`SELECT o.order_ref AS orderRef,
      json_extract(o.data_json,'$.refundSummary.currency') AS currency,
      json_extract(o.data_json,'$.refundSummary.amountMinor') AS amountMinor
    FROM amazon_observations o JOIN amazon_captures c ON c.digest=o.capture_digest
    WHERE o.family='order' AND json_type(o.data_json,'$.refundSummary')='object'
      AND o.order_ref IN (SELECT value FROM json_each(?))
    ORDER BY c.rowid,o.ordinal,o.ref`).all(JSON.stringify([...idByRef.keys()])) as
    Array<{ orderRef: string; currency: unknown; amountMinor: unknown }>;
  for (const row of totals) {
    const id = idByRef.get(row.orderRef);
    // Malformed values pass through as they are, so orderRefundTotal counts them invalid rather than dropping them.
    if (id !== undefined) (byOrder.get(id)!.summaries as Money[]).push({ currency: row.currency as string, amountMinor: row.amountMinor as number });
  }

  const runs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_capture_runs'").get()
    ? new Map((db.prepare('SELECT capture_digest,run_id FROM amazon_capture_runs').all() as
      Array<{ capture_digest: string; run_id: string }>).map(r => [r.capture_digest, r.run_id])) : new Map<string, string>();
  const observations: LedgerRefundObservation[] = [];
  for (const row of db.prepare(`SELECT o.capture_digest AS captureDigest,o.data_json AS data
    FROM amazon_observations o JOIN amazon_captures c ON c.digest=o.capture_digest
    WHERE c.format_version=3 AND o.family IN ('payment','refund') ORDER BY c.rowid,o.ordinal,o.ref`).iterate() as
    IterableIterator<{ captureDigest: string; data: string }>) {
    const p = JSON.parse(row.data) as Partial<PaymentObservation>;
    const source = p.provenance;
    if (!source || source.source !== 'ledger' || !Number.isInteger(source.page) || !Number.isInteger(source.ordinal)) continue;
    const orderIds = Array.isArray(p.orderIds) ? p.orderIds : [];
    observations.push({
      run: runs.get(row.captureDigest) ?? `capture:${row.captureDigest}`,
      page: source.page, ordinal: source.ordinal,
      evidence: digest([p.date ?? null, p.money ?? null, p.kind ?? null, p.status ?? null, p.method ?? null,
        [...orderIds].sort(), p.identity ?? null, source.status ?? null]),
      refund: p.kind === 'refund' && p.status === 'completed' && source.status === 'Refunded' && p.money
        ? { date: p.date as string, money: p.money, orderIds, repeat: p.identity === 'ambiguous-repeat' } : null,
    });
  }
  const { groups, excluded } = dedupeLedgerRefunds(observations);
  const asked = (orderIds: readonly string[]) => orderIds.some(id => byOrder.has(id));
  const counts = new Map<LedgerExclusion, number>();
  const exclude = (reason: LedgerExclusion, count: number) => {
    if (count > 0) counts.set(reason, (counts.get(reason) ?? 0) + count);
  };
  for (const group of groups) {
    // One of a run's identical rows counts (the provable minimum); the others are left out and counted, never added.
    if (asked(group.orderIds)) exclude('ambiguous-repeat', group.ambiguousRepeats);
    if (group.orderIds.length > 1) {
      if (asked(group.orderIds)) exclude('multiple-orders', group.events);
      continue;
    }
    const evidence = byOrder.get(group.orderIds[0]);
    if (!evidence) continue;
    for (let n = 0; n < group.events; n++) (evidence.ledger as Money[]).push({ currency: group.currency, amountMinor: group.amountMinor });
    evidence.ledgerObservations += group.observations;
  }
  for (const entry of excluded) if (asked(entry.orderIds)) exclude(entry.reason, 1);
  answer.excluded = [...counts].map(([reason, count]) => ({ reason, count }));
  if (hasRefundEventSchema(db)) readPageRefunds(db, byOrder);
  return answer;
}

const ISSUED: ReadonlySet<string> = new Set(REFUND_ISSUED_PHRASES);
const parse = (text: string | undefined): unknown => { try { return text === undefined ? null : JSON.parse(text); } catch { return null; } };
const issued = (r: RefundEvidence) => r.kind === 'refund' && r.status === 'completed' && ISSUED.has(r.provenance.phrase);

/**
 * The asked orders' order-details and Returns-page refund statements (#155's projection), issued or not, each item
 * named as the statement's own capture shows it: its ASIN, else its exact title (a Returns-page item's own, an
 * order-details line's in the capture that read it). A position is never identity. Each statement keeps its capture's
 * import order and its projection event, so refundEventNetting.ts can follow each refund's history once every
 * statement is tied to its stable line.
 */
function readPageRefunds(db: Database, byOrder: Map<string, OrderRefundEvidenceRead>): void {
  const ids = JSON.stringify([...byOrder.keys()]);
  const lineAt = db.prepare('SELECT data_json FROM amazon_items WHERE order_ref=? AND native_line_id=?').pluck();
  for (const row of db.prepare(`SELECT e.ref AS event,e.source AS source,o.capture_digest AS capture,c.rowid AS seq,o.data_json AS data
    FROM amazon_refund_events e JOIN amazon_refund_event_members m ON m.event_ref=e.ref
    JOIN amazon_observations o ON o.ref=m.observation_ref JOIN amazon_captures c ON c.digest=o.capture_digest
    WHERE e.kind='refund' AND e.source IN ('order-details','returns-page')
      AND json_extract(e.data_json,'$.orderIds[0]') IN (SELECT value FROM json_each(?))
    ORDER BY c.rowid,o.ordinal,e.ref`).iterate(ids) as
    IterableIterator<{ event: string; source: PageRefundSource; capture: string; seq: number; data: string }>) {
    const value = parse(row.data);
    if (!isRefundEvidence(value) || value.kind !== 'refund' || value.provenance.source !== row.source || !byOrder.has(value.orderIds[0])) continue;
    const orderId = value.orderIds[0];
    const items: PageRefundItem[] = value.items.map(item => {
      if (row.source === 'returns-page') return { lineOrdinal: null, itemId: item.itemId, title: item.title, units: item.units };
      const line = parse(lineAt.get(opaque('order', orderId), `${row.capture}:${item.lineOrdinal}`) as string | undefined) as ItemObservation | null;
      return { lineOrdinal: null, itemId: typeof line?.itemId === 'string' ? line.itemId : null,
        title: typeof line?.title === 'string' ? line.title : null, units: item.units };
    });
    const completed = issued(value);
    byOrder.get(orderId)!.pageRefunds.push({ source: row.source, money: completed && value.money ? { ...value.money } : null,
      contradictory: false, items, observations: 1, issued: completed, capture: row.seq, event: row.event });
  }
}
