import type { Database } from 'better-sqlite3';
import { digest, opaque } from './policy.js';
import { hasAmazonSchema, hasRefundEventSchema } from './schema.js';
import type { Method, Money, PaymentObservation, RefundEvidence, RefundEvidenceItem } from './types.js';

/**
 * Refund-family projection: deterministic, rebuilt inside every guarded import from retained v3 observations.
 * One event per refund or return of ONE source, however many captures saw it. Events never merge across sources
 * (ledger, order-details, Returns page): linking a ledger credit to a page statement is attribution, not identity.
 */
export const REFUND_EVENT_POLICY = Object.freeze({
  version: 'amazon-refund-events-v2',
  ledgerIdentity: 'date-currency-magnitude-method-sorted-orders-plus-in-capture-repeat',
  evidenceIdentity: 'source-kind-order-item-key-plus-in-capture-repeat',
  merge: 'same-source-only',
  latest: 'import-order-return-created-never-overrides-a-stated-status',
  status: 'only-advances-pending-or-started-in-transit-received-completed-or-cancelled-a-step-back-is-a-conflict',
  destinations: 'ledger-row-instrument-or-stated',
});
/** Order-details/Returns-page observations take refund-family ordinals from here: payment ordinals stay below 800. */
export const REFUND_EVIDENCE_ORDINAL_BASE = 1000;

export type RefundEventSource = 'ledger' | 'order-details' | 'returns-page';
export interface RefundDestination { method: Method; money: Money | null; basis: 'ledger-row-instrument' | 'stated' }
export interface RefundEventView {
  ref: string;
  kind: 'refund' | 'return';
  source: RefundEventSource;
  status: 'completed' | 'pending' | 'started' | 'in-transit' | 'received' | 'cancelled';
  /** Native order IDs: service-internal only, never an API response field. */
  orderIds: string[];
  date: string | null;
  /** Positive refunded magnitude; null when no observation stated it. Returns never carry money. */
  money: Money | null;
  destinations: RefundDestination[];
  items: RefundEvidenceItem[];
  observations: number;
  /** Earliest and latest capture window end among members (a backfill slice keeps its cursor's window). */
  firstSeen: string;
  lastSeen: string;
  /** The most recently imported observation's capture: order-details `items[].lineOrdinal` index its lines only. */
  latestCapture: string;
  /** Observations of this event disagreed on a stated refund amount, date or destination, or a stated status went back. */
  conflict: boolean;
  members: Array<{ observationRef: string; refundRef: string | null }>;
}

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
export function isLedgerRefund(value: unknown): value is PaymentObservation {
  const p = value as PaymentObservation | null;
  return !!p && typeof p === 'object' && p.kind === 'refund' && p.status === 'completed'
    && p.provenance?.source === 'ledger' && p.provenance.status === 'Refunded'
    && !!p.money && !!p.method && Array.isArray(p.orderIds);
}
export function isRefundEvidence(value: unknown): value is RefundEvidence {
  const r = value as RefundEvidence | null;
  return !!r && typeof r === 'object' && ['refund', 'return'].includes(r.kind)
    && ['order-details', 'returns-page'].includes(r.provenance?.source) && Array.isArray(r.orderIds)
    && Array.isArray(r.items) && Array.isArray(r.destinations);
}
/** The one instrument a ledger Refunded row shows is the instrument it credits; an unknown instrument states none. */
export function ledgerDestination(p: PaymentObservation): RefundDestination | null {
  return p.method.kind === 'unknown' ? null
    : { method: p.method, money: { currency: p.money.currency, amountMinor: Math.abs(p.money.amountMinor) }, basis: 'ledger-row-instrument' };
}
const itemKey = (items: RefundEvidenceItem[]) => !items.length ? 'order' : items.map(i => i.itemId !== null ? `asin:${i.itemId}`
  : i.lineOrdinal !== null ? `line:${i.lineOrdinal}` : `title:${digest(i.title)}`).sort().join('|');

interface Member {
  eventRef: string; observationRef: string; refundRef: string | null; seen: string; captureDigest: string;
  kind: 'refund' | 'return'; source: RefundEventSource; status: RefundEventView['status']; phrase: string | null;
  orderIds: string[]; date: string | null; money: Money | null; destinations: RefundDestination[]; items: RefundEvidenceItem[];
}
// Backfill slices keep their cursor's window, so a window end is not an observation time: import order is.
function readMembers(db: Database): Member[] {
  const rows = db.prepare(`SELECT o.ref,o.capture_digest,o.ordinal,o.data_json,c.window_through FROM amazon_observations o
    JOIN amazon_captures c ON c.digest=o.capture_digest WHERE o.family='refund' AND c.format_version=3
    ORDER BY c.rowid,o.ordinal`).all() as
    Array<{ ref: string; capture_digest: string; ordinal: number; data_json: string; window_through: string }>;
  const refunds = new Set(db.prepare('SELECT ref FROM amazon_refunds').pluck().all() as string[]);
  const repeats = new Map<string, number>(), members: Member[] = [];
  for (const row of rows) {
    const value = parse(row.data_json);
    let identity: unknown[], member: Omit<Member, 'eventRef' | 'observationRef' | 'refundRef' | 'seen' | 'captureDigest'>, refundRef: string;
    if (isLedgerRefund(value)) {
      const money = { currency: value.money.currency, amountMinor: Math.abs(value.money.amountMinor) };
      const destination = ledgerDestination(value);
      identity = ['ledger', value.date, money.currency, money.amountMinor, value.method.kind, value.method.network,
        value.method.last4, [...value.orderIds].sort()];
      member = { kind: 'refund', source: 'ledger', status: 'completed', phrase: null, orderIds: [...value.orderIds].sort(),
        date: value.date, money, destinations: destination ? [destination] : [], items: [] };
      refundRef = opaque('refund-observation', [row.capture_digest, row.ordinal]);
    } else if (isRefundEvidence(value) && row.ordinal >= REFUND_EVIDENCE_ORDINAL_BASE) {
      identity = [value.provenance.source, value.kind, value.orderIds[0], itemKey(value.items)];
      member = { kind: value.kind, source: value.provenance.source, status: value.status, phrase: value.provenance.phrase,
        orderIds: [...value.orderIds], date: value.date, money: value.money, items: value.items,
        destinations: value.destinations.map(d => ({ method: d.method, money: d.money, basis: 'stated' as const })) };
      refundRef = opaque('refund-observation', [row.capture_digest, 'evidence', row.ordinal - REFUND_EVIDENCE_ORDINAL_BASE]);
    } else continue;
    // The k-th identical occurrence within one capture is the k-th event: repeats across captures collapse,
    // genuinely repeated refunds inside one capture never do.
    const repeatKey = digest([row.capture_digest, identity]);
    const repeat = repeats.get(repeatKey) ?? 0;
    repeats.set(repeatKey, repeat + 1);
    members.push({ ...member, eventRef: opaque('refund-event', [...identity, repeat]), observationRef: row.ref,
      refundRef: refunds.has(refundRef) ? refundRef : null, seen: row.window_through, captureDigest: row.capture_digest });
  }
  return members;
}
type StoredEvent = Omit<RefundEventView, 'ref' | 'members'>;
/** How far a refund or return has come. A refund goes pending → completed; a return started → in transit → received →
 * completed, or ends cancelled, as final as completed. */
const STATUS_STEP: Readonly<Record<RefundEventView['status'], number>> = Object.freeze({
  pending: 0, started: 0, 'in-transit': 1, received: 2, completed: 3, cancelled: 3 });
function eventOf(members: Member[]): StoredEvent {
  const latest = members[members.length - 1];
  // A stated status only advances, in import order: a later step is an update, the same one a no-op, and a step back
  // (or the other final status) a conflict that stays in history. "Return created" only says a return exists: it never
  // states, overrides or regresses a status a page actually stated.
  let statusMember: Member | undefined, regressed = false;
  for (const m of members) {
    if (m.phrase === 'return-created') continue;
    if (!statusMember || STATUS_STEP[m.status] > STATUS_STEP[statusMember.status]) statusMember = m;
    else if (m.status !== statusMember.status) regressed = true;
  }
  const stated = <T>(pick: (m: Member) => T | null | undefined, present: (v: T) => boolean = () => true) => {
    const values = members.map(pick).filter((v): v is T => v !== null && v !== undefined && present(v));
    return { value: values.length ? values[values.length - 1] : null, distinct: new Set(values.map(v => digest(v))).size };
  };
  const money = stated(m => m.money), destinations = stated(m => m.destinations, v => v.length > 0);
  // A return's status moves through dated steps; only a refund's stated date must agree.
  const date = stated(m => m.date);
  const days = members.map(m => m.seen).sort();
  return { kind: latest.kind, source: latest.source, status: (statusMember ?? latest).status, orderIds: latest.orderIds,
    date: date.value, money: money.value, destinations: destinations.value ?? [], items: latest.items,
    observations: members.length, firstSeen: days[0], lastSeen: days[days.length - 1], latestCapture: latest.captureDigest,
    conflict: regressed || money.distinct > 1 || destinations.distinct > 1 || (latest.kind === 'refund' && date.distinct > 1) };
}
/**
 * Root's progression rule, for the importer's display decision: the orders whose statements in an incoming capture take
 * back a refund or return status their event already reached. What each event reached is rebuilt in memory, under this
 * policy's rule (its furthest stated step), from every retained observation: never read from the persisted projection,
 * which an earlier policy may have written (#155's v1 kept the latest status), so the decision is the same whether or not
 * a reconcile ran first. A step back, or the other final return status, regresses; the same step or a later one never
 * does, and a `return-created` default never states a status. Read-only. Call it before the capture's own observations
 * are retained; each statement is matched to its event as the projection would match it.
 */
// STEP 9 integration (revocation)
export function regressedRefundOrders(db: Database, records: readonly RefundEvidence[]): Set<string> {
  const reached = new Map<string, RefundEventView['status']>(), regressed = new Set<string>();
  if (!records.length || !hasAmazonSchema(db)) return regressed;
  for (const m of readMembers(db)) {
    if (m.phrase === 'return-created') continue;
    const status = reached.get(m.eventRef);
    if (status === undefined || STATUS_STEP[m.status] > STATUS_STEP[status]) reached.set(m.eventRef, m.status);
  }
  const repeats = new Map<string, number>();
  for (const record of records) {
    if (!isRefundEvidence(record)) continue;
    const identity = [record.provenance.source, record.kind, record.orderIds[0], itemKey(record.items)];
    const key = digest(identity), repeat = repeats.get(key) ?? 0;
    repeats.set(key, repeat + 1);
    if (record.provenance.phrase === 'return-created') continue;
    const status = reached.get(opaque('refund-event', [...identity, repeat]));
    if (status && (STATUS_STEP[record.status] < STATUS_STEP[status]
      || (STATUS_STEP[record.status] === STATUS_STEP[status] && record.status !== status))) regressed.add(record.orderIds[0]);
  }
  return regressed;
}
/**
 * Caller owns the backed-up write transaction. Adds destination rows for refund observations that show one
 * (idempotent, deterministic refs) and rebuilds the event projection. Returns digests for the caller's audit.
 */
export function projectRefundEvents(db: Database): { events: number; before: string; after: string } {
  const insertDestination = db.prepare('INSERT OR IGNORE INTO amazon_refund_destinations VALUES(?,?,?,?)');
  for (const row of db.prepare('SELECT ref,data_json FROM amazon_refunds ORDER BY ref').all() as Array<{ ref: string; data_json: string }>) {
    const value = parse(row.data_json);
    const destinations = isLedgerRefund(value) ? [ledgerDestination(value)].filter((d): d is RefundDestination => d !== null)
      : isRefundEvidence(value) && value.kind === 'refund'
        ? value.destinations.map(d => ({ method: d.method, money: d.money, basis: 'stated' as const })) : [];
    for (const [index, destination] of destinations.entries()) {
      insertDestination.run(opaque('refund-destination', [row.ref, index]), row.ref, destination.method.kind, JSON.stringify(destination));
    }
  }
  const snapshot = () => digest(db.prepare(`SELECT e.ref,e.data_json,
    (SELECT json_group_array(observation_ref) FROM (SELECT observation_ref FROM amazon_refund_event_members m
      WHERE m.event_ref=e.ref ORDER BY observation_ref)) AS members FROM amazon_refund_events e ORDER BY e.ref`).all());
  const before = snapshot();
  db.prepare('DELETE FROM amazon_refund_event_members').run();
  db.prepare('DELETE FROM amazon_refund_events').run();
  const grouped = new Map<string, Member[]>();
  for (const member of readMembers(db)) grouped.set(member.eventRef, [...(grouped.get(member.eventRef) ?? []), member]);
  const insertEvent = db.prepare('INSERT INTO amazon_refund_events VALUES(?,?,?,?,?)');
  const insertMember = db.prepare('INSERT INTO amazon_refund_event_members VALUES(?,?,?)');
  for (const [ref, members] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const event = eventOf(members);
    insertEvent.run(ref, event.kind, event.source, event.status, JSON.stringify(event));
    for (const m of members) insertMember.run(ref, m.observationRef, m.refundRef);
  }
  return { events: grouped.size, before, after: snapshot() };
}
/** Read-only; a database last written before the additive event tables existed simply has no events yet. */
export function listRefundEvents(db: Database, orderIds?: ReadonlySet<string>): RefundEventView[] {
  if (!hasAmazonSchema(db) || !hasRefundEventSchema(db)) return [];
  const members = new Map<string, RefundEventView['members']>();
  for (const m of db.prepare(`SELECT event_ref,observation_ref,refund_ref FROM amazon_refund_event_members
    ORDER BY event_ref,observation_ref`).all() as Array<{ event_ref: string; observation_ref: string; refund_ref: string | null }>) {
    members.set(m.event_ref, [...(members.get(m.event_ref) ?? []), { observationRef: m.observation_ref, refundRef: m.refund_ref }]);
  }
  return (db.prepare('SELECT ref,data_json FROM amazon_refund_events ORDER BY ref').all() as Array<{ ref: string; data_json: string }>)
    .map(row => ({ ref: row.ref, ...(JSON.parse(row.data_json) as StoredEvent), members: members.get(row.ref) ?? [] }))
    .filter(event => !orderIds || event.orderIds.some(id => orderIds.has(id)));
}
