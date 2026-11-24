import type { MatchSubject, Staging, LedgerRow, CardIdentity, RootApproval, BindingProposal, RefundEvidence, OrderObservation } from './types.js';
import { digest, opaque, POLICY_DIGEST, SOURCE } from './policy.js';

// Entirely synthetic; these are not captured household identifiers, titles or card endings.
export const syntheticCards: CardIdentity[] = [
  { id: 'synthetic-prime', issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', status: 'active' },
  { id: 'synthetic-marriott', issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD', status: 'active' },
];
export function rootApproval(p: BindingProposal): RootApproval {
  return { format: 'holdr.amazon-root-approval', version: 1, authority: 'Root', decision: 'approved',
    proposalDigest: digest(p), policyDigest: POLICY_DIGEST, inventoryDigest: p.inventoryDigest };
}
export function syntheticCapture(version: 1 | 2 | 3 = 3): { structure: unknown; staging: Staging } {
  const orders: Staging['orders'] = [{
    orderId: '000-0000001-0000001', date: '2026-09-01', total: { currency: 'USD', amountMinor: 1100 },
    items: [{ itemId: 'SYNTH00001', title: 'Synthetic blue widget', quantity: 1, unitPrice: { currency: 'USD', amountMinor: 1000 },
      ...(version === 3 ? { lineOrdinal: 0 } : {}) }],
    ...(version >= 2 ? { paymentCoverage: { status: 'held' as const, reason: 'selector-failed' as const } } : {}),
    ...(version === 3 ? { paymentMethods: [{ kind: 'card' as const, network: 'visa' as const, last4: '9001' }],
      summary: [{ kind: 'items-subtotal' as const, money: { currency: 'USD', amountMinor: 1000 } },
        { kind: 'shipping' as const, money: { currency: 'USD', amountMinor: 0 } },
        { kind: 'tax' as const, money: { currency: 'USD', amountMinor: 100 } },
        { kind: 'grand-total' as const, money: { currency: 'USD', amountMinor: 1100 } }],
      tenderCoverage: 'single-card-proven' as const,
      tenderProof: { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false } } : {}),
  }];
  return {
    structure: { format: 'holdr.amazon-structure', version: 2, scope: 'value-free-unobserved-is-unknown',
      code: 'complete', requests: 0, pages: [], stop: null },
    staging: {
      format: 'holdr.amazon-staging', version, source: SOURCE,
      ...(version === 3 ? { runId: '00000000-0000-4000-8000-000000000001' } : {}),
      window: { from: '2026-08-21', through: '2026-10-19', timeZone: 'America/New_York' },
      coverage: {
        orders: { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 },
        payments: { status: 'held', reason: 'selector-failed', pages: 0, records: 0, rejected: 0 },
        details: { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 },
        refunds: { status: 'held', reason: 'selector-failed', pages: 0, records: 0, rejected: 0 },
      },
      resume: { orders: [], payments: null, details: [], restartPayments: true },
      orders, payments: [],
    },
  };
}
export function syntheticSubject(patch: Partial<MatchSubject> = {}): MatchSubject {
  return {
    ref: opaque('subject', 'one'), source: SOURCE, evidenceClass: 'payment-event', nativeOccurrenceId: 'synthetic-occurrence-one',
    provenance: 'ledger-Charged', status: 'completed', date: '2026-09-01',
    money: { amountMinor: 1100, currency: 'USD' }, method: { kind: 'card', network: 'visa', last4: '9001' },
    orderRefs: [opaque('order', 'one')], tenderProof: 'single-card-complete', allocationComplete: false, allocations: [],
    ...patch,
  };
}
export function syntheticBackfillCapture(years: number[] = []) {
  const c = syntheticCapture();
  c.staging.mode = 'backfill'; c.staging.window.from = '2024-10-19';
  c.staging.resume.orders = years.map(year => ({ year, startIndex: 0 }));
  c.staging.resume.restartPayments = false;
  const completed = c.staging.orders.map(order => order.orderId);
  return {
    staging: c.staging,
    structure: { format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown',
      code: 'complete', requests: 0, pages: [], stop: null,
      progress: { mode: 'backfill', state: years.length ? 'in-progress' : 'complete',
        position: years.length ? 'orders' : 'complete', runs: 1, pagesDone: 0, ordersDone: completed.length,
        detailsPending: 0, yearsPending: years.length, terminalHeld: 0, unresolvedHeld: 0, ledgerPage: 0,
        totalEstimate: completed.length, linked: 0, constructed: 0 } },
    continuation: { before: null, after: {
      version: 1, id: '00000000-0000-4000-8000-000000000099', revision: 1, origin: 'https://www.amazon.com',
      window: { ...c.staging.window },
      queue: years.map(year => `/your-orders/orders?startIndex=0&timeFilter=year-${year}`),
      headers: [], completed, seen: [], signatures: [], terminalHeld: [], terminalRearmed: [],
      unresolvedHeld: [], unresolvedRearmed: [], constructedLists: [],
      stats: { pages: 0, orders: completed.length, payments: 0, details: completed.length, linked: 0, constructed: 0 },
    } },
  };
}
/**
 * The synthetic order, complete and single-card: two lines that reconcile to its 1100 total, so a 1100 card charge
 * links to it and splits over its lines. `imageIds` gives each line its captured image ID, by place.
 */
export function syntheticCompleteOrder(...imageIds: Array<string | undefined>): OrderObservation {
  const order = syntheticCapture().staging.orders[0];
  order.itemProof = { complete: true, unknownLine: false, conflict: false };
  order.items[0].unitPrice!.amountMinor = 500;
  order.items.push({ ...structuredClone(order.items[0]), lineOrdinal: 1, itemId: 'SYNTH00002', title: 'Synthetic second widget' });
  order.items.forEach((item, n) => { if (imageIds[n]) item.imageId = imageIds[n]; });
  return order;
}
/** A recent read of the complete synthetic order. */
export function syntheticCompleteCapture(...imageIds: Array<string | undefined>) {
  const capture = syntheticCapture();
  capture.staging.orders = [syntheticCompleteOrder(...imageIds)];
  capture.staging.coverage.details.records = 2;
  return capture;
}
/**
 * A targeted detail re-read as the producer drains one (the panel driver's proof-retry checks): a v3 backfill slice
 * that continues a saved cursor (`revision - 1` to `revision`), of one detail request, with the order as re-read and no
 * payments. `run` gives it its own run ID, so its own digest; by default its cursor revision follows its run.
 */
export function syntheticRereadCapture(order: OrderObservation, run = 2, revision = run) {
  const c = syntheticBackfillCapture();
  c.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  c.staging.orders = [structuredClone(order)];
  c.staging.coverage.details.records = order.items.length;
  const after = { ...c.continuation.after, revision, completed: [order.orderId],
    stats: { ...c.continuation.after.stats, orders: 1, details: 1 } };
  return {
    staging: c.staging,
    structure: { ...c.structure, requests: 1,
      progress: { ...c.structure.progress, runs: revision, ordersDone: 1, totalEstimate: 1 } },
    continuation: { before: { id: after.id, revision: revision - 1 }, after },
  };
}
export function syntheticRow(patch: Partial<LedgerRow> = {}): LedgerRow {
  return { id: 'synthetic-card-row', cardAccountId: 'synthetic-prime', transactionDate: '2026-09-02',
    status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD', userCategory: null, ...patch };
}
/** Synthetic image bytes: the formats' leading signatures with made-up content, never a real product image. */
export const syntheticJpeg = (label = 'one') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic-${label}`)]);
export const syntheticPng = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
export const syntheticWebp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPsynthetic')]);
/** A 1x1 GIF, as the image host answers for an ASIN it has no image for. */
export const placeholderGif = (width = 1, height = 1) => Buffer.concat([Buffer.from('GIF89a'),
  Buffer.from([width, 0, height, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b])]);
/** Extra synthetic lines for the synthetic order: made-up ASINs and titles, with the coverage count that matches. */
export function withSyntheticItems(capture: { staging: Staging }, count: number) {
  const order = capture.staging.orders[0];
  for (let n = order.items.length; n < count; n++) {
    order.items.push({ lineOrdinal: n, itemId: `SYNTH${String(n + 1).padStart(5, '0')}`, title: `Synthetic gadget ${n + 1}`,
      quantity: 1, unitPrice: null });
  }
  capture.staging.coverage.details.records = capture.staging.orders.reduce((n, o) => n + o.items.length, 0);
  return capture;
}
/** A synthetic displayed refund/return status; defaults to an order-details refund of the synthetic order's line 0. */
export function syntheticEvidence(patch: Partial<RefundEvidence> = {}): RefundEvidence {
  return { kind: 'refund', status: 'completed', date: '2026-09-10', money: { currency: 'USD', amountMinor: 1100 },
    orderIds: ['000-0000001-0000001'], destinations: [],
    items: [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: null, units: null }],
    provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-issued' }, ...patch } as RefundEvidence;
}
/** Appends records and keeps the producer's refunds coverage count (ledger refunds plus refund-kind evidence). */
export function withRefundEvidence<T extends { staging: Staging }>(capture: T, records: RefundEvidence[]): T {
  const s = capture.staging;
  s.refundEvidence = [...(s.refundEvidence ?? []), ...records];
  const refunds = s.payments.filter(p => p.kind === 'refund').length + s.refundEvidence.filter(r => r.kind === 'refund').length;
  s.coverage.refunds = { ...s.coverage.refunds, status: refunds ? 'partial' : 'held', records: refunds,
    reason: refunds ? 'read-only-limit' : s.coverage.refunds.reason };
  return capture;
}
/** The producer's returns-only shape: the 730-day window, one Returns page, no orders, payments, cursor or progress. */
export function syntheticReturnsCapture(records: RefundEvidence[] = []) {
  const c = syntheticCapture();
  const held = { status: 'held' as const, reason: 'selector-failed', pages: 0, records: 0, rejected: 0 };
  c.staging.mode = 'backfill'; c.staging.window.from = '2024-10-19';
  c.staging.orders = [];
  c.staging.coverage = { orders: held, payments: held, details: held, refunds: { ...held, pages: 1 } };
  c.staging.refundEvidence = [];
  const structure = { format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown', code: 'complete',
    requests: 2, stop: null, pages: [{ kind: 'returns', elements: 1, truncated: false, attributes: [], classes: [], paths: [],
      queries: [], diagnostics: { failures: [], scopes: [], omittedScopes: 0, exhausted: false } }] };
  return withRefundEvidence({ structure: structure as unknown, staging: c.staging }, records);
}
