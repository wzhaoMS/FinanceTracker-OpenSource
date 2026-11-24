import type { Database } from 'better-sqlite3';
import { largestRemainderUnits } from '@finance-tracker/shared';
import { digest, minor, opaque, ref, SOURCE } from './policy.js';
import { singleCardProven } from './tender.js';
import type { Allocation, HoldReason, OrderObservation, MatchResult, MatchSubject } from './types.js';

/**
 * Integer products, without floating-point rounding. A tie goes to the lower stable tie key: `tie` when given (the line
 * identity, lineTieKeys), else the opaque ref, never to anything that changes when the same order is read again. The
 * arithmetic is the shared largestRemainderUnits (integerShares.ts); the checks and the refusal are the domain's.
 */
export function largestRemainder(total: number, weights: readonly { ref: string; weight: number; tie?: string }[]): Map<string, number> {
  if (!minor(total) || total < 0 || !weights.length || new Set(weights.map(w => w.ref)).size !== weights.length
    || new Set(weights.map(w => w.tie ?? w.ref)).size !== weights.length
    || weights.some(w => !ref(w.ref) || (w.tie !== undefined && !ref(w.tie)) || !minor(w.weight) || w.weight <= 0)) {
    throw Error('amazon allocation refused');
  }
  const units = largestRemainderUnits(BigInt(total), weights.map(w => ({ ref: w.ref, weight: BigInt(w.weight), tie: w.tie ?? w.ref })));
  return new Map([...units].map(([key, n]) => [key, Number(n)]));
}
/**
 * Stable rounding identity (order-history v3): each line's tie key is its order plus its exact title, the part of its
 * matching identity (ASIN, else exact title) that every display replacement keeps, since a superset may learn an ASIN
 * but never changes a known title, plus its occurrence among the order's lines with that title, by line ordinal. A
 * capture-scoped ref or an image ID never decides a tied cent, so re-reading the same order moves no cent between lines.
 */
export function lineTieKeys(order: OrderObservation): Map<number, string> {
  const seen = new Map<string, number>(), keys = new Map<number, string>();
  for (const item of [...order.items].sort((a, b) => a.lineOrdinal! - b.lineOrdinal!)) {
    const occurrence = seen.get(item.title) ?? 0;
    seen.set(item.title, occurrence + 1);
    keys.set(item.lineOrdinal!, opaque('line-identity', [order.orderId, item.title, occurrence]));
  }
  return keys;
}
/** One entry of a proven collection: each attribute it states, as a value digest. An unread attribute is absent. */
export type ProvenEntry = ReadonlyMap<string, string>;
/**
 * Order-history policy v3: what an observation proves, each fact only where it proves it. A null or unknown value is
 * unread, so absent: never a value. The total when present; the tender coverage when known; and three proven
 * collections, each a multiset of entries compared by identity, never by position: under a complete item proof (no
 * unknown line or conflict) its lines, by every attribute but the line ordinal (a position) and the display-only
 * `imageId`; under method completeness its instruments, by kind, network and last four; under summary completeness its
 * components, by kind and amount. The Refund Total, the date and anything unread are never facts: post-order refunds
 * are never purchase evidence.
 */
export interface ProvenOrderFacts {
  total?: string;
  tenderCoverage?: string;
  items?: ProvenEntry[];
  methods?: ProvenEntry[];
  summary?: ProvenEntry[];
}
const entry = (value: object, unread: (attribute: string, value: unknown) => boolean): ProvenEntry =>
  new Map(Object.entries(value).filter(([attribute, v]) => v !== null && v !== undefined && !unread(attribute, v))
    .map(([attribute, v]) => [attribute, digest(v)]));
export function provenOrderFacts(order: OrderObservation): ProvenOrderFacts {
  const items = order.itemProof, tender = order.tenderProof, facts: ProvenOrderFacts = {};
  if (order.total) facts.total = digest(order.total);
  if (order.tenderCoverage && order.tenderCoverage !== 'unknown') facts.tenderCoverage = order.tenderCoverage;
  if (items?.complete && !items.unknownLine && !items.conflict) {
    facts.items = order.items.map(item => entry(item, attribute => attribute === 'lineOrdinal' || attribute === 'imageId'));
  }
  if (tender?.methodComplete) facts.methods = (order.paymentMethods ?? []).map(method => entry(method, (_, v) => v === 'unknown'));
  if (tender?.summaryComplete) facts.summary = (order.summary ?? []).map(component => entry(component, () => false));
  return facts;
}
const agree = (a: ProvenEntry, b: ProvenEntry) => [...a].every(([attribute, value]) => !b.has(attribute) || b.get(attribute) === value);
const canonical = (entries: readonly ProvenEntry[]) =>
  digest(entries.map(e => JSON.stringify([...e].sort(([x], [y]) => (x < y ? -1 : 1)))).sort());
/**
 * Whether two proven collections can be the same: their entries pair one to one, in any order, each pair agreeing on
 * every attribute both state. An attribute one of them leaves unread never differs. Exact equality is checked first;
 * otherwise a bipartite matching by augmenting paths (at most 100 entries a side).
 */
export function sameProvenCollection(a: readonly ProvenEntry[], b: readonly ProvenEntry[]): boolean {
  if (a.length !== b.length) return false;
  if (canonical(a) === canonical(b)) return true;
  const partner = new Array<number>(b.length).fill(-1);
  const pair = (i: number, seen: boolean[]): boolean => b.some((candidate, j) => {
    if (seen[j] || !agree(a[i], candidate)) return false;
    seen[j] = true;
    if (partner[j] >= 0 && !pair(partner[j], seen)) return false;
    partner[j] = i;
    return true;
  });
  return a.every((_, i) => pair(i, new Array<boolean>(b.length).fill(false)));
}
export type OrderObservationScope = 'header-only' | 'tender-unread' | 'legacy';
/** The order observation's stored hold reason for a marked scope (the importer's and the batch check's), and back. */
export const SCOPE_HOLD_REASONS: Readonly<Record<Exclude<OrderObservationScope, 'legacy'>, string>> = Object.freeze({
  'header-only': 'header-only-observation', 'tender-unread': 'tender-unread-observation',
});
export function observationScope(holdReason: string): OrderObservationScope {
  return holdReason === SCOPE_HOLD_REASONS['header-only'] ? 'header-only'
    : holdReason === SCOPE_HOLD_REASONS['tender-unread'] ? 'tender-unread' : 'legacy';
}
export function emptyOrderDetails(order: OrderObservation): boolean {
  return order.items.length === 0 && order.paymentMethods?.length === 0 && order.summary?.length === 0
    && order.tenderCoverage === 'unknown' && !!order.tenderProof
    && Object.values(order.tenderProof).every(value => value === false)
    && (!order.itemProof || Object.values(order.itemProof).every(value => value === false))
    && !order.refundSummary;
}
/**
 * Order-history policy v4: observations conflict only on an explicit item proof conflict, an explicit tender proof
 * conflict, or when a fact both prove differs: a different total or known tender coverage, or two proven collections that
 * cannot be the same (sameProvenCollection). A tender conflict its capture attributes only to unread tender (scope
 * `tender-unread`: an unknown summary label, a held summary or an unread method block, orderObservationScope) is no
 * contradiction, so it holds nothing (Root, 2026-11-22); that observation proves no fact it could not read. A missing,
 * unread or unproven fact never conflicts, so a header-only, method-only or title-only re-read holds an order's
 * allocation only through a fact it proves with a different value, and a later read that only learns an unread value,
 * or lists the same entries in another order, never does. The header-only marker stays in history but no longer decides
 * this.
 */
export function orderHistoryConflicts(observations: readonly { order: OrderObservation; scope?: OrderObservationScope }[]): boolean {
  if (observations.some(s => s.order.itemProof?.conflict
    || (s.order.tenderProof?.conflict && s.scope !== 'tender-unread'))) return true;
  const facts = observations.map(s => provenOrderFacts(s.order));
  for (const fact of ['total', 'tenderCoverage'] as const) {
    if (new Set(facts.flatMap(f => (f[fact] === undefined ? [] : [f[fact]]))).size > 1) return true;
  }
  for (const fact of ['items', 'methods', 'summary'] as const) {
    const lists = [...new Map(facts.flatMap(f => (f[fact] ? [[canonical(f[fact]!), f[fact]!] as const] : []))).values()];
    if (lists.some((list, i) => lists.slice(i + 1).some(other => !sameProvenCollection(list, other)))) return true;
  }
  return false;
}
export interface OrderSnapshot {
  order: OrderObservation; captureDigest: string; version: number; scope: OrderObservationScope;
}
/** Select one actual complete observation, never manufacture proof by unioning partial snapshots. */
export function readOrderHistory(db: Database, orderRef: string): {
  snapshots: OrderSnapshot[]; conflict: boolean; displayed: string | null;
} {
  const rows = db.prepare(`SELECT o.capture_digest,o.data_json,o.hold_reason,c.format_version FROM amazon_observations o
    JOIN amazon_captures c ON c.digest=o.capture_digest
    WHERE o.family='order' AND o.order_ref=? ORDER BY c.rowid DESC,o.ordinal DESC`).all(orderRef) as
      Array<{ capture_digest: string; data_json: string; hold_reason: string; format_version: number }>;
  const snapshots = rows.map(row => ({ order: JSON.parse(row.data_json) as OrderObservation,
    captureDigest: row.capture_digest, version: row.format_version,
    scope: observationScope(row.hold_reason) }));
  const displayed = (db.prepare('SELECT latest_digest FROM amazon_orders WHERE ref=?').pluck().get(orderRef) as string | undefined) ?? null;
  return { snapshots, conflict: orderHistoryConflicts(snapshots), displayed };
}
/**
 * The observation an allocation derives from: the displayed one when it qualifies (#168: allocation follows the display,
 * so the owner decisions a display replacement carries are the ones it uses), else the newest that does.
 */
export function selectOrderTotalSnapshot(snapshots: readonly OrderSnapshot[], displayed: string | null = null): OrderSnapshot | undefined {
  const pick = (qualifies: (s: OrderSnapshot) => boolean) =>
    snapshots.find(s => s.captureDigest === displayed && qualifies(s)) ?? snapshots.find(qualifies);
  return pick(s => s.version === 3 && singleCardProven(s.order) && itemBlockReconciles(s.order))
    ?? pick(s => s.version === 3 && singleCardProven(s.order)) ?? snapshots[0];
}
export function orderTotalSubject(order: OrderObservation, captureDigest: string, version: number, conflict: boolean): MatchSubject {
  const single = version === 3 && order.tenderCoverage === 'single-card-proven' && singleCardProven(order);
  const allocation = single ? allocateOrder(order, captureDigest, conflict) : null;
  return {
    ref: opaque('order-total', order.orderId), source: SOURCE, evidenceClass: 'unique-total-match',
    nativeOccurrenceId: null, provenance: single ? 'order-total' : 'unproven',
    status: 'completed', date: order.date, money: order.total ?? { currency: 'USD', amountMinor: 0 },
    method: single ? order.paymentMethods![0] : { kind: 'unknown', network: 'unknown', last4: null },
    orderRefs: [opaque('order', order.orderId)],
    tenderProof: single ? 'single-card-complete' : order.tenderCoverage === 'multi-tender' ? 'mixed' : 'unknown',
    allocations: allocation?.allocations ?? [], allocationComplete: allocation?.complete ?? false,
    ...(allocation?.reason ? { allocationHoldReason: allocation.reason } : {}),
  };
}
export function itemBlockReconciles(order: OrderObservation): boolean {
  const proof = order.itemProof;
  const subtotal = order.summary?.filter(s => s.kind === 'items-subtotal');
  if (!proof?.complete || proof.unknownLine || proof.conflict || order.items.length < 1 || order.items.length > 100
    || !subtotal || subtotal.length !== 1 || !minor(subtotal[0].money.amountMinor) || subtotal[0].money.amountMinor < 0
    || new Set(order.items.map(i => i.lineOrdinal)).size !== order.items.length
    || order.items.some(i => !Number.isInteger(i.lineOrdinal) || i.lineOrdinal! < 0 || i.lineOrdinal! > 99
      || !Number.isInteger(i.quantity) || i.quantity! < 1 || i.quantity! > 999 || !i.unitPrice
      || !minor(i.unitPrice.amountMinor) || i.unitPrice.amountMinor < 0
      || i.unitPrice.currency !== subtotal[0].money.currency)) return false;
  if ([...order.items].sort((a, b) => a.lineOrdinal! - b.lineOrdinal!).some((i, ordinal) => i.lineOrdinal !== ordinal)) return false;
  return order.items.reduce((n, i) => n + BigInt(i.quantity!) * BigInt(i.unitPrice!.amountMinor), 0n)
    === BigInt(subtotal[0].money.amountMinor);
}
export function allocateOrder(order: OrderObservation, captureDigest: string, conflict: boolean):
  { allocations: Allocation[]; complete: boolean; reason?: HoldReason } {
  const hold = (reason: HoldReason) => ({ allocations: [], complete: false, reason });
  if (conflict) return hold('inconsistent-evidence');
  if (order.tenderCoverage !== 'single-card-proven' || !singleCardProven(order)) return hold('mixed-tender-unproven');
  if (!itemBlockReconciles(order)) return hold('item-identity-unproven');
  if (order.items.some(i => i.unitPrice!.currency !== order.total!.currency)) return hold('currency-mismatch');
  const ties = lineTieKeys(order);
  const weights = order.items.map(i => ({ ref: opaque('line-observation', [captureDigest, order.orderId, i.lineOrdinal]),
    tie: ties.get(i.lineOrdinal!)!, weight: Number(BigInt(i.quantity!) * BigInt(i.unitPrice!.amountMinor)) })).filter(w => w.weight > 0);
  if (!weights.length || weights.some(w => !minor(w.weight))) return hold('inconsistent-evidence');
  const summary = new Map(order.summary!.map(s => [s.kind, s.money.amountMinor]));
  if (weights.reduce((n, w) => n + BigInt(w.weight), 0n) !== BigInt(summary.get('items-subtotal')!)) {
    return hold('inconsistent-evidence');
  }

  const shipping = largestRemainder(summary.get('shipping')!, weights);
  const tax = largestRemainder(summary.get('tax')!, weights);
  const promotion = largestRemainder(summary.get('promotion') ?? 0, weights);
  const allocations: Allocation[] = [];
  for (const w of weights) {
    const net = BigInt(shipping.get(w.ref)!) + BigInt(tax.get(w.ref)!) - BigInt(promotion.get(w.ref)!);
    const base = { itemRef: w.ref, currency: order.total!.currency, attribution: 'order-total-policy' as const, sourceCategory: null };
    if (net < 0n) {
      const amount = BigInt(w.weight) + net;
      if (amount < 0n) return hold('negative-component');
      if (amount) allocations.push({ ...base, amountMinor: Number(amount), classification: 'policy-allocated' });
    } else {
      allocations.push({ ...base, amountMinor: w.weight, classification: 'source' });
      if (net) allocations.push({ ...base, amountMinor: Number(net), classification: 'policy-allocated' });
    }
  }
  if (allocations.some(a => !minor(a.amountMinor))
    || allocations.reduce((n, a) => n + BigInt(a.amountMinor), 0n) !== BigInt(order.total!.amountMinor)) return hold('inconsistent-evidence');
  return { allocations, complete: true };
}

/** Purchase arithmetic excludes post-order refund summaries and separates non-card tender from discounts. */
export function ledgerOrderProof(order: OrderObservation): { nonCard: number } | null {
  const p = order.tenderProof;
  if (!p?.summaryComplete || p.unknownSummary || p.conflict || !p.methodComplete || p.unknownMethod
    || !order.total || !minor(order.total.amountMinor) || order.total.amountMinor <= 0 || !itemBlockReconciles(order)) return null;
  if (!order.paymentMethods?.length || order.paymentMethods.some(m => m.kind === 'unknown'
    || (m.kind === 'card' && (m.network === 'unknown' || !m.last4 || !/^\d{4}$/.test(m.last4))))) return null;
  const summary = order.summary ?? [];
  const amounts = new Map(summary.map(s => [s.kind, s.money.amountMinor]));
  if (amounts.size !== summary.length || (['items-subtotal', 'shipping', 'tax', 'grand-total'] as const).some(k => !amounts.has(k))
    || summary.some(s => !minor(s.money.amountMinor) || s.money.currency !== order.total!.currency
      || (!['gift-card', 'rewards'].includes(s.kind) && s.money.amountMinor < 0))) return null;
  const total = BigInt(amounts.get('items-subtotal')!) + BigInt(amounts.get('shipping')!) + BigInt(amounts.get('tax')!)
    - BigInt(amounts.get('promotion') ?? 0);
  const nonCard = summary.filter(s => ['gift-card', 'rewards'].includes(s.kind))
    .reduce((n, s) => n + BigInt(Math.abs(s.money.amountMinor)), 0n);
  if (total !== BigInt(order.total.amountMinor) || amounts.get('grand-total') !== order.total.amountMinor
    || nonCard > total) return null;
  return { nonCard: Number(nonCard) };
}

/** Derives policy allocations from the union of distinct card anchors, never by merging Amazon event fingerprints. */
export function allocateLedgerSubjects(db: Database, subjects: readonly MatchSubject[], results: readonly MatchResult[]): MatchSubject[] {
  const resultByRef = new Map(results.map(r => [r.subjectRef, r]));
  const subjectsByRef = new Map(subjects.map(s => [s.ref, s]));
  const byOrder = new Map<string, MatchSubject[]>();
  for (const s of subjects) if (s.evidenceClass === 'payment-ledger-complete') {
    for (const orderRef of new Set(s.orderRefs)) {
      const list = byOrder.get(orderRef) ?? [];
      list.push(s); byOrder.set(orderRef, list);
    }
  }
  const allocated = new Map<string, MatchSubject>();
  const anchor = (s: MatchSubject): MatchResult | undefined => {
    let r = resultByRef.get(s.ref);
    const visited = new Set<string>();
    while (r?.corroboratedBy && !visited.has(r.subjectRef)) {
      visited.add(r.subjectRef); r = resultByRef.get(r.corroboratedBy);
    }
    return r?.state === 'linked' ? r : undefined;
  };
  for (const [orderRef, observations] of byOrder) {
    const stored = db.prepare('SELECT latest_digest,data_json FROM amazon_orders WHERE ref=?').get(orderRef) as
      { latest_digest: string; data_json: string } | undefined;
    const history = readOrderHistory(db, orderRef);
    const selected = history.snapshots.find(s => s.captureDigest === history.displayed && ledgerOrderProof(s.order))
      ?? history.snapshots.find(s => ledgerOrderProof(s.order));
    const order = selected?.order ?? (stored ? JSON.parse(stored.data_json) as OrderObservation : null);
    const proof = order ? ledgerOrderProof(order) : null;
    const conflict = history.conflict;
    const holds = new Map<string, HoldReason>();
    for (const s of observations) holds.set(s.ref, conflict ? 'inconsistent-evidence' : 'item-identity-unproven');
    if (order && stored && proof && !conflict) {
      const ties = lineTieKeys(order);
      const weights = order.items.map(i => ({
        ref: opaque('line-observation', [selected?.captureDigest ?? stored.latest_digest, order.orderId, i.lineOrdinal]),
        tie: ties.get(i.lineOrdinal!)!,
        weight: Number(BigInt(i.quantity!) * BigInt(i.unitPrice!.amountMinor)),
      })).filter(w => w.weight > 0);
      const tieOf = new Map(weights.map(w => [w.ref, w.tie]));
      const validWeights = weights.length > 0 && weights.every(w => minor(w.weight));
      const charges = observations.filter(s => s.status === 'completed' && s.provenance === 'ledger-Charged');
      const anchors = new Map<string, { subject: MatchSubject; result: MatchResult }>();
      for (const s of charges) {
        const r = anchor(s);
        if (r?.cardTransactionId) anchors.set(r.cardTransactionId, { subject: s, result: r });
      }
      const sum = [...anchors.values()].reduce((n, a) => n + BigInt(a.subject.money.amountMinor), 0n);
      const methodsAgree = charges.every(s => order.paymentMethods!.some(m => m.kind === 'card' && s.method.kind === 'card'
        && m.network === s.method.network && m.last4 === s.method.last4));
      const complete = charges.length > 0 && charges.every(s => anchor(s) && s.money.currency === order.total!.currency)
        && methodsAgree
        && sum > 0n && sum + BigInt(proof.nonCard) === BigInt(order.total!.amountMinor);
      if (validWeights && complete) {
        const remaining = largestRemainder(Number(sum), weights);
        for (const [, a] of [...anchors].sort(([a], [b]) => a.localeCompare(b))) {
          const portions = largestRemainder(a.subject.money.amountMinor,
            [...remaining].filter(([, weight]) => weight > 0).map(([ref, weight]) => ({ ref, weight, tie: tieOf.get(ref)! })));
          const allocations: Allocation[] = [];
          for (const [itemRef, amountMinor] of portions) {
            remaining.set(itemRef, remaining.get(itemRef)! - amountMinor);
            if (amountMinor) allocations.push({ itemRef, amountMinor, currency: order.total!.currency,
              attribution: 'payment-ledger-policy', classification: 'policy-allocated', sourceCategory: null });
          }
          const canonical = subjectsByRef.get(a.result.subjectRef)!;
          if (canonical.evidenceClass === 'payment-ledger-complete') {
            allocated.set(canonical.ref, { ...canonical, allocations, allocationComplete: true });
          }
        }
        if ([...remaining.values()].some(n => n !== 0)) throw Error('amazon allocation conservation refused');
      } else for (const s of charges) holds.set(s.ref, methodsAgree ? 'mixed-tender-unproven' : 'inconsistent-evidence');
    }
    // Refunds stay unattributed here: refundCredits.ts itemizes a linked credit only by mirroring its order's itemized charges.
    for (const s of observations) if (!allocated.has(s.ref)) {
      allocated.set(s.ref, { ...s, allocationHoldReason: s.provenance === 'ledger-Refunded'
        ? 'refund-unattributed' : holds.get(s.ref)! });
    }
  }
  return subjects.map(s => allocated.get(s.ref) ?? s);
}
