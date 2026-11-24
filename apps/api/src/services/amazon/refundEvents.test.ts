import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, importAmazonCapture } from './importer.js';
import { syntheticBackfillCapture, syntheticCapture, syntheticEvidence, syntheticReturnsCapture,
  withRefundEvidence } from './fixtures.testSupport.js';
import { validateCapture, validateRefundEvidence } from './capture.js';
import { listRefundEvents, REFUND_EVIDENCE_ORDINAL_BASE, regressedRefundOrders } from './refundEvents.js';
import { amazonSummary, getAmazonOrder, listAmazonOrders } from './readModel.js';
import { readSubjects } from './matcher.js';
import { hasRefundEventSchema } from './schema.js';
import type { PaymentObservation, RefundEvidence, Staging } from './types.js';

let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const count = (sql: string, ...args: unknown[]) => db().prepare(sql).pluck().get(...args) as number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-refund-synthetic-'));
  backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Entirely synthetic: invented order IDs, ASINs, titles, amounts and card endings.
const ledgerRefund = (patch: Partial<PaymentObservation> = {}, ordinal = 0): PaymentObservation => ({
  date: '2026-09-12', money: { currency: 'USD', amountMinor: 1100 }, kind: 'refund', status: 'completed',
  method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: ['000-0000001-0000001'], identity: 'native-row',
  provenance: { source: 'ledger', status: 'Refunded', page: 0, ordinal }, ...patch });
function withLedger<T extends { staging: Staging }>(capture: T, payments: PaymentObservation[]): T {
  const s = capture.staging;
  s.payments.push(...payments);
  const refunds = s.payments.filter(p => p.kind === 'refund').length + (s.refundEvidence ?? []).filter(r => r.kind === 'refund').length;
  s.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: s.payments.length, rejected: 0 };
  s.coverage.refunds = { status: refunds ? 'partial' : 'held', reason: 'budget', pages: 1, records: refunds, rejected: 0 };
  return capture;
}
/** Same content, a distinct capture digest: a later run whose window ends on `through`. */
const rerun = <T extends { staging: Staging }>(capture: T, n: number, through = '2026-10-19'): T => {
  const next = structuredClone(capture);
  next.staging.runId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const days = next.staging.mode === 'backfill' ? 730 : 59;
  next.staging.window.from = new Date(Date.parse(through) - days * 86400000).toISOString().slice(0, 10);
  next.staging.window.through = through;
  return next;
};
const detailsReturn = (patch: Partial<RefundEvidence> = {}) => syntheticEvidence({ kind: 'return', status: 'completed',
  money: null, date: null, provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: 'return-complete' },
  ...patch } as Partial<RefundEvidence>);
const returnsRefund = (patch: Partial<RefundEvidence> = {}) => syntheticEvidence({
  items: [{ lineOrdinal: null, itemId: 'SYNTH00001', title: 'Synthetic blue widget', units: 1 }],
  provenance: { source: 'returns-page', page: 0, ordinal: 1, phrase: 'refund-issued' },
  destinations: [{ method: { kind: 'card', network: 'visa', last4: '9001' }, money: { currency: 'USD', amountMinor: 1100 } }],
  ...patch } as Partial<RefundEvidence>);
const returnsReturn = (patch: Partial<RefundEvidence> = {}) => returnsRefund({ kind: 'return', status: 'started',
  money: null, destinations: [], date: '2026-09-04',
  provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'return-created' }, ...patch } as Partial<RefundEvidence>);

describe('refund evidence capture boundary', () => {
  it('accepts closed order-details evidence and returns-only captures alongside unchanged envelopes', async () => {
    await expect(validateCapture(withRefundEvidence(syntheticCapture(), [syntheticEvidence(), detailsReturn()]))).resolves.toBeDefined();
    // An expected refund (an amount beside a return status alone) is pending and states no money, date or destination.
    await expect(validateCapture(withRefundEvidence(syntheticCapture(), [syntheticEvidence({ status: 'pending', money: null, date: null,
      provenance: { source: 'order-details', page: 0, ordinal: 2, phrase: 'refund-for-return' } })]))).resolves.toBeDefined();
    await expect(validateCapture(syntheticReturnsCapture([returnsReturn(), returnsRefund(),
      returnsRefund({ date: null, provenance: { source: 'returns-page', page: 0, ordinal: 2, phrase: 'refund-complete' } }),
      returnsReturn({ orderIds: ['000-0000009-0000009'], provenance: { source: 'returns-page', page: 0, ordinal: 3,
        phrase: 'return-requested' } })]))).resolves.toBeDefined();
    await expect(validateCapture(syntheticReturnsCapture())).resolves.toBeDefined();
    await expect(validateCapture(syntheticCapture())).resolves.toBeDefined();
    await expect(validateCapture(syntheticBackfillCapture())).resolves.toBeDefined();
  });
  type Fixture = { structure: unknown; staging: Staging };
  const details = (): Fixture => withRefundEvidence(syntheticCapture(), [syntheticEvidence()]);
  const returns = (): Fixture => syntheticReturnsCapture([returnsRefund()]);
  const first = (c: Fixture) => c.staging.refundEvidence![0];
  const invalid: Array<[string, () => Fixture, (c: Fixture) => void]> = [
    ['an unknown phrase', details, c => { (first(c).provenance as { phrase: string }).phrase = 'refund-maybe'; }],
    ['a phrase that names another kind', details, c => { first(c).provenance.phrase = 'return-complete'; }],
    ['a phrase that names another status', details, c => { first(c).provenance.phrase = 'refund-pending'; }],
    ['an expected refund marked completed', details, c => { first(c).provenance.phrase = 'refund-for-return'; }],
    ['a pending refund stating money', details, c => { first(c).status = 'pending'; first(c).provenance.phrase = 'refund-pending'; }],
    ['a pending refund stating a date', details, c => { Object.assign(first(c), { status: 'pending', money: null });
      first(c).provenance.phrase = 'refund-pending'; }],
    ['a pending refund stating a destination', returns, c => { Object.assign(first(c), { status: 'pending', money: null, date: null,
      destinations: [{ method: { kind: 'card', network: 'visa', last4: '9001' }, money: null }] });
      first(c).provenance.phrase = 'refund-pending'; }],
    ['money on a return', details, c => { Object.assign(first(c), { kind: 'return', status: 'completed',
      provenance: { ...first(c).provenance, phrase: 'return-complete' } }); }],
    ['zero refund money', details, c => { first(c).money = { currency: 'USD', amountMinor: 0 }; }],
    ['another currency', details, c => { first(c).money = { currency: 'EUR', amountMinor: 100 }; }],
    ['an unknown destination', details, c => { first(c).destinations = [
      { method: { kind: 'unknown', network: 'unknown', last4: null }, money: null }] as never; }],
    ['destination money above the refund', details, c => { first(c).destinations = [
      { method: { kind: 'card', network: 'visa', last4: '9001' }, money: { currency: 'USD', amountMinor: 1200 } }] as never; }],
    ['fully split destinations that do not sum', details, c => { first(c).destinations = [
      { method: { kind: 'card', network: 'visa', last4: '9001' }, money: { currency: 'USD', amountMinor: 600 } },
      { method: { kind: 'balance', network: 'unknown', last4: null }, money: { currency: 'USD', amountMinor: 400 } }] as never; }],
    ['destination money without a refund amount', details, c => { first(c).money = null;
      first(c).destinations = [
        { method: { kind: 'card', network: 'visa', last4: '9001' }, money: { currency: 'USD', amountMinor: 600 } }] as never; }],
    ['an unstaged order on an order-details record', details, c => { first(c).orderIds = ['000-0000009-0000009']; }],
    ['a line the order does not have', details, c => { first(c).items[0].lineOrdinal = 5; }],
    ['an ASIN that is not the line\'s', details, c => { first(c).items[0].itemId = 'SYNTH00009'; }],
    ['a title on an order-details line', details, c => { first(c).items[0].title = 'Synthetic blue widget'; }],
    ['zero units', details, c => { first(c).items[0].units = 0; }],
    ['a date outside the window', details, c => { first(c).date = '2026-01-01'; }],
    ['an invalid date', details, c => { first(c).date = '2026-02-30'; }],
    ['two order IDs', details, c => { first(c).orderIds = ['000-0000001-0000001', '000-0000001-0000001'] as never; }],
    ['an extra key', details, c => { Object.assign(first(c), { note: 'synthetic' }); }],
    ['a duplicated occurrence', details, c => { c.staging.refundEvidence!.push(structuredClone(first(c)));
      c.staging.coverage.refunds.records++; }],
    ['an uncounted refund record', details, c => { c.staging.coverage.refunds.records = 0; c.staging.coverage.refunds.status = 'held'; }],
    ['Returns-page evidence in an ordinary capture', details, c => { c.staging.refundEvidence = [returnsRefund()]; }],
    ['order-details evidence in a returns-only capture', returns, c => {
      c.staging.refundEvidence = [syntheticEvidence({ orderIds: ['000-0000009-0000009'] })]; }],
    ['a returns-only capture carrying orders', returns, c => { c.staging.orders = syntheticCapture().staging.orders;
      c.staging.coverage.orders = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
      c.staging.coverage.details = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 }; }],
    ['a returns-only capture without its evidence key', returns, c => { delete c.staging.refundEvidence;
      c.staging.coverage.refunds = { status: 'held', reason: 'selector-failed', pages: 1, records: 0, rejected: 0 }; }],
    ['a Returns-page return without its created date', returns, c => { Object.assign(first(c), returnsReturn({ date: null })); }],
    ['a Returns-page line ordinal', returns, c => { first(c).items[0].lineOrdinal = 0; }],
    ['a Returns-page item with neither ASIN nor title', returns, c => {
      first(c).items[0] = { lineOrdinal: null, itemId: null, title: null, units: null }; }],
    ['a Returns-page title with a URL', returns, c => { first(c).items[0].title = 'see https://example.invalid'; }],
  ];
  it.each(invalid)('refuses %s', async (_name, make, mutate) => {
    const capture = make();
    await expect(validateCapture(capture)).resolves.toBeDefined();
    mutate(capture);
    await expect(validateCapture(capture)).rejects.toThrow();
  });
  // Exact type and value: an allowed string wrapped in an array, an object or replaced by null never coerces through,
  // in the API mirror on its own and end to end, before any write.
  const wrappers: Array<[string, (v: string) => unknown]> = [
    ['an array', v => [v]], ['an object', v => ({ toString: () => v, valueOf: () => v })], ['null', () => null]];
  type Wrapped = Record<string, unknown>;
  const wrappedFields: Array<[string, () => Fixture, (c: Fixture, w: (v: string) => unknown) => void]> = [
    ['phrase', details, (c, w) => { (first(c).provenance as unknown as Wrapped).phrase = w('refund-issued'); }],
    ['source', details, (c, w) => { (first(c).provenance as unknown as Wrapped).source = w('order-details'); }],
    ['destination kind', returns, (c, w) => { (first(c).destinations[0].method as unknown as Wrapped).kind = w('card'); }],
    ['destination network', returns, (c, w) => { (first(c).destinations[0].method as unknown as Wrapped).network = w('visa'); }],
    ['window start', details, (c, w) => { (c.staging.window as unknown as Wrapped).from = w(c.staging.window.from); }],
    ['window end', details, (c, w) => { (c.staging.window as unknown as Wrapped).through = w(c.staging.window.through); }],
  ];
  it.each(wrappedFields.flatMap(([field, make, mutate]) => wrappers.map(([how, wrap]) => [field, how, make, mutate, wrap] as const)))(
    'refuses a %s wrapped in %s', async (_field, _how, make, mutate, wrap) => {
      const capture = make();
      const mirror = () => validateRefundEvidence(capture.staging.refundEvidence, capture.staging.orders,
        capture.staging.window as unknown as Record<string, unknown>);
      expect(mirror).not.toThrow();
      mutate(capture, wrap);
      expect(mirror).toThrow();
      await expect(validateCapture(capture)).rejects.toThrow();
    });
  it('refuses evidence on pre-v3 staging', async () => {
    const capture = syntheticCapture(2);
    (capture.staging as Staging).refundEvidence = [];
    await expect(validateCapture(capture)).rejects.toThrow();
  });
});

describe('refund evidence import and same-source event identity', () => {
  it('stores every record as a refund-family observation and only refunds as amazon_refunds rows', async () => {
    const receipt = await importAmazonCapture(db(), withRefundEvidence(syntheticCapture(),
      [syntheticEvidence(), detailsReturn({ date: '2026-09-08' })]), backup());
    expect(receipt.holds).toEqual(expect.arrayContaining([{ reason: 'refund-evidence-unattributed', count: 1 },
      { reason: 'return-is-not-refund', count: 1 }]));
    await importAmazonCapture(db(), syntheticReturnsCapture([returnsReturn(), returnsRefund(),
      returnsReturn({ orderIds: ['000-0000009-0000009'], provenance: { source: 'returns-page', page: 0, ordinal: 2,
        phrase: 'return-requested' } })]), backup());
    expect(count(`SELECT count(*) FROM amazon_observations WHERE family='refund' AND ordinal>=?`, REFUND_EVIDENCE_ORDINAL_BASE)).toBe(5);
    // Only orders already staged are linked; an unknown order keeps a NULL order_ref.
    expect(count("SELECT count(*) FROM amazon_observations WHERE family='refund' AND order_ref IS NOT NULL")).toBe(4);
    expect(count('SELECT count(*) FROM amazon_refunds')).toBe(2);
    expect(count("SELECT count(*) FROM amazon_refunds WHERE execution_status='issued'")).toBe(2);
    // Only the stated Returns-page destination: the order-details refund stated none.
    expect(db().prepare('SELECT kind,data_json FROM amazon_refund_destinations').all()).toEqual([{ kind: 'card',
      data_json: JSON.stringify({ method: { kind: 'card', network: 'visa', last4: '9001' },
        money: { currency: 'USD', amountMinor: 1100 }, basis: 'stated' }) }]);
    const events = listRefundEvents(db());
    expect(events.map(e => [e.source, e.kind, e.status]).sort()).toEqual([
      ['order-details', 'refund', 'completed'], ['order-details', 'return', 'completed'],
      ['returns-page', 'refund', 'completed'], ['returns-page', 'return', 'started'], ['returns-page', 'return', 'started']]);
    const [detailsCapture] = db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid').pluck().all();
    expect(events.find(e => e.source === 'order-details' && e.kind === 'refund')).toMatchObject({
      date: '2026-09-10', money: { currency: 'USD', amountMinor: 1100 }, destinations: [], observations: 1,
      items: [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: null, units: null }], latestCapture: detailsCapture, conflict: false,
      firstSeen: '2026-10-19', lastSeen: '2026-10-19', orderIds: ['000-0000001-0000001'] });
    expect(events.every(e => e.members.length === 1)).toBe(true);
    expect(events.filter(e => e.kind === 'return').every(e => e.members[0].refundRef === null)).toBe(true);
    // Card matching subjects and the legacy ledger refund view ignore page evidence entirely.
    expect(readSubjects(db()).some(s => s.provenance.startsWith('ledger'))).toBe(false);
    const order = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
    expect(order.refunds).toEqual([]);
    expect(listRefundEvents(db(), new Set(['000-0000009-0000009'])).map(e => e.kind)).toEqual(['return']);
  });
  it('collapses the same refund and return seen by several captures into one event with the latest status', async () => {
    const started = detailsReturn({ status: 'started', date: '2026-09-05',
      provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: 'return-started' } } as Partial<RefundEvidence>);
    await importAmazonCapture(db(), withRefundEvidence(syntheticCapture(), [started]), backup());
    const completed = detailsReturn({ date: '2026-09-09' });
    await importAmazonCapture(db(), withRefundEvidence(rerun(syntheticCapture(), 2, '2026-10-20'), [completed, syntheticEvidence()]), backup());
    const third = withRefundEvidence(rerun(syntheticCapture(), 3, '2026-10-21'), [completed, syntheticEvidence()]);
    await importAmazonCapture(db(), third, backup());
    const events = listRefundEvents(db());
    expect(events).toHaveLength(2);
    expect(events.find(e => e.kind === 'return')).toMatchObject({ status: 'completed', date: '2026-09-09', observations: 3,
      firstSeen: '2026-10-19', lastSeen: '2026-10-21', conflict: false });
    expect(events.find(e => e.kind === 'refund')).toMatchObject({ status: 'completed', observations: 2, conflict: false });
    expect(count('SELECT count(*) FROM amazon_refunds')).toBe(2);
    // Re-importing an already imported capture adds nothing and keeps every event ref.
    const refs = events.map(e => e.ref).sort();
    expect(await importAmazonCapture(db(), structuredClone(third), backup())).toMatchObject({ newCaptures: 0, newObservations: 0 });
    expect(listRefundEvents(db()).map(e => e.ref).sort()).toEqual(refs);
    expect(count("SELECT count(*) FROM amazon_audit WHERE action='refund-events-projected'")).toBe(3);
  });
  it('collapses the same Returns-page return across returns-only captures', async () => {
    await importAmazonCapture(db(), syntheticReturnsCapture([returnsReturn()]), backup());
    await importAmazonCapture(db(), rerun(syntheticReturnsCapture([returnsReturn({ status: 'in-transit',
      provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'return-in-transit' } } as Partial<RefundEvidence>),
    returnsRefund()]), 2, '2026-10-20'), backup());
    const events = listRefundEvents(db());
    expect(events.map(e => [e.kind, e.status, e.observations]).sort()).toEqual([['refund', 'completed', 1], ['return', 'in-transit', 2]]);
    expect(events.find(e => e.kind === 'return')!.items).toEqual([{ lineOrdinal: null, itemId: 'SYNTH00001',
      title: 'Synthetic blue widget', units: 1 }]);
    // A later box whose heading is the refund only re-states that the return exists: the stated status stands.
    await importAmazonCapture(db(), rerun(syntheticReturnsCapture([returnsReturn(), returnsRefund()]), 3, '2026-10-21'), backup());
    expect(listRefundEvents(db()).find(e => e.kind === 'return')).toMatchObject({ status: 'in-transit', observations: 3 });
  });
  it('takes the most recently imported observation as latest, whatever its capture window', async () => {
    await importAmazonCapture(db(), syntheticReturnsCapture([returnsReturn({ status: 'in-transit',
      provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'return-in-transit' } } as Partial<RefundEvidence>)]), backup());
    // A slice that keeps an older cursor window but is imported later still describes the later read.
    await importAmazonCapture(db(), rerun(syntheticReturnsCapture([returnsReturn({ status: 'received',
      provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'return-received' } } as Partial<RefundEvidence>)]),
    2, '2026-10-01'), backup());
    expect(listRefundEvents(db())).toEqual([expect.objectContaining({ status: 'received', observations: 2,
      firstSeen: '2026-10-01', lastSeen: '2026-10-19' })]);
  });
  it('keeps the summary\'s ledger refund counts: page evidence is not a ledger refund observation', async () => {
    await importAmazonCapture(db(), withLedger(withRefundEvidence(syntheticCapture(), [syntheticEvidence(), detailsReturn()]),
      [ledgerRefund()]), backup());
    await importAmazonCapture(db(), syntheticReturnsCapture([returnsReturn(), returnsRefund()]), backup());
    expect(amazonSummary(db())).toMatchObject({ refundObservations: 1, issuedRefundObservations: 1 });
  });
  it('keeps the latest stated refund amount but flags observations that disagree', async () => {
    await importAmazonCapture(db(), withRefundEvidence(syntheticCapture(), [syntheticEvidence()]), backup());
    await importAmazonCapture(db(), withRefundEvidence(rerun(syntheticCapture(), 2, '2026-10-20'),
      [syntheticEvidence({ money: { currency: 'USD', amountMinor: 900 } })]), backup());
    expect(listRefundEvents(db())).toEqual([expect.objectContaining({ observations: 2, conflict: true,
      money: { currency: 'USD', amountMinor: 900 } })]);
  });
  // Root's monotonic progression: a stated status only advances in import order. A later step is an update, the same one
  // a no-op, and a step back (or the other final return status) a conflict that keeps the furthest status.
  const refundStated = (status: 'pending' | 'completed') => status === 'completed' ? syntheticEvidence()
    : syntheticEvidence({ status: 'pending', money: null, date: null,
      provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-pending' } } as Partial<RefundEvidence>);
  const returnPhrases = { started: 'return-started', 'in-transit': 'return-in-transit', received: 'return-received',
    completed: 'return-complete', cancelled: 'return-cancelled' } as const;
  const returnStated = (status: keyof typeof returnPhrases) => detailsReturn({ status,
    provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: returnPhrases[status] } } as Partial<RefundEvidence>);
  const progressions: Array<[string, RefundEvidence[], string, boolean]> = [
    ['a refund pending, then completed: an update', [refundStated('pending'), refundStated('completed')], 'completed', false],
    ['a refund completed, then pending: a conflict', [refundStated('completed'), refundStated('pending')], 'completed', true],
    ['a refund completed twice: a no-op', [refundStated('completed'), refundStated('completed')], 'completed', false],
    ['a return started, received, then completed', [returnStated('started'), returnStated('received'), returnStated('completed')],
      'completed', false],
    ['a return started, then cancelled', [returnStated('started'), returnStated('cancelled')], 'cancelled', false],
    ['a return received, then in transit: a conflict', [returnStated('received'), returnStated('in-transit')], 'received', true],
    ['a return completed, then cancelled: a conflict', [returnStated('completed'), returnStated('cancelled')], 'completed', true],
  ];
  it.each(progressions)('keeps statuses only advancing: %s', async (_, records, status, conflict) => {
    for (const [n, record] of records.entries()) {
      await importAmazonCapture(db(), withRefundEvidence(rerun(syntheticCapture(), n + 1, `2026-10-${19 + n}`), [record]), backup());
    }
    expect(listRefundEvents(db())).toEqual([expect.objectContaining({ status, conflict, observations: records.length })]);
  });
  it('tells the importer which of a capture\'s statements take back a status their event already reached', async () => {
    const orderId = syntheticCapture().staging.orders[0].orderId;
    await importAmazonCapture(db(), withRefundEvidence(syntheticCapture(), [returnStated('received')]), backup());
    const regressed = (record: RefundEvidence, order = orderId) => regressedRefundOrders(db(), [record]).has(order);
    expect(regressed(returnStated('received'))).toBe(false);
    expect(regressed(returnStated('completed'))).toBe(false);
    expect(regressed(returnStated('in-transit'))).toBe(true);
    expect(regressed(returnStated('started'))).toBe(true);
    // A `return-created` default never states a status; another order, or a statement no event holds yet, never regresses.
    expect(regressed(detailsReturn({ status: 'started', provenance: { source: 'order-details', page: 0, ordinal: 1,
      phrase: 'return-created' } } as Partial<RefundEvidence>))).toBe(false);
    expect(regressed(returnStated('started'), '000-0000009-0000009')).toBe(false);
    expect(regressed(refundStated('pending'))).toBe(false);
    await importAmazonCapture(db(), withRefundEvidence(rerun(syntheticCapture(), 2, '2026-10-20'), [returnStated('completed')]), backup());
    expect(regressed(returnStated('cancelled'))).toBe(true);
    expect(regressed(returnStated('completed'))).toBe(false);
    // Rebuilt from the retained observations, never read from the stored projection: a stale one (as #155's v1 kept the
    // latest status) or none at all decides nothing.
    db().prepare(`UPDATE amazon_refund_events SET status='started',data_json=json_set(data_json,'$.status','started')`).run();
    expect(regressed(returnStated('received'))).toBe(true);
    db().prepare('DELETE FROM amazon_refund_event_members').run();
    db().prepare('DELETE FROM amazon_refund_events').run();
    expect(regressed(returnStated('cancelled'))).toBe(true);
    expect(regressed(returnStated('completed'))).toBe(false);
  });
  it('never merges events across sources or kinds', async () => {
    await importAmazonCapture(db(), withLedger(withRefundEvidence(syntheticCapture(), [syntheticEvidence(), detailsReturn()]),
      [ledgerRefund()]), backup());
    await importAmazonCapture(db(), syntheticReturnsCapture([returnsReturn(), returnsRefund()]), backup());
    expect(listRefundEvents(db()).map(e => `${e.source}/${e.kind}`).sort()).toEqual(
      ['ledger/refund', 'order-details/refund', 'order-details/return', 'returns-page/refund', 'returns-page/return']);
  });
  it('gives ledger Refunded rows one event per refund across captures, keeping genuine repeats within a capture', async () => {
    const twin = { ...ledgerRefund({}, 1), identity: 'ambiguous-repeat' as const };
    await importAmazonCapture(db(), withLedger(syntheticCapture(),
      [{ ...ledgerRefund(), identity: 'ambiguous-repeat' }, twin]), backup());
    expect(listRefundEvents(db())).toHaveLength(2);
    await importAmazonCapture(db(), withLedger(rerun(syntheticCapture(), 2, '2026-10-20'), [ledgerRefund()]), backup());
    await importAmazonCapture(db(), withLedger(rerun(syntheticCapture(), 3, '2026-10-21'),
      [ledgerRefund({ date: '2026-09-13' })]), backup());
    const events = listRefundEvents(db()).sort((a, b) => b.observations - a.observations || a.date!.localeCompare(b.date!));
    expect(events.map(e => [e.date, e.observations])).toEqual([['2026-09-12', 2], ['2026-09-12', 1], ['2026-09-13', 1]]);
    expect(events[0]).toMatchObject({ source: 'ledger', kind: 'refund', status: 'completed', items: [],
      money: { currency: 'USD', amountMinor: 1100 }, destinations: [{ method: { kind: 'card', network: 'visa', last4: '9001' },
        money: { currency: 'USD', amountMinor: 1100 }, basis: 'ledger-row-instrument' }] });
    expect(events.flatMap(e => e.members).every(m => m.refundRef !== null)).toBe(true);
  });
  it('writes one ledger-instrument destination per shown instrument, and none for an unknown one', async () => {
    await importAmazonCapture(db(), withLedger(syntheticCapture(), [ledgerRefund({ money: { currency: 'USD', amountMinor: -1100 } }),
      ledgerRefund({ method: { kind: 'unknown', network: 'unknown', last4: null }, orderIds: [] }, 1),
      ledgerRefund({ method: { kind: 'balance', network: 'unknown', last4: null } }, 2)]), backup());
    expect(db().prepare('SELECT kind,data_json FROM amazon_refund_destinations ORDER BY kind').all()).toEqual([
      { kind: 'balance', data_json: JSON.stringify({ method: { kind: 'balance', network: 'unknown', last4: null },
        money: { currency: 'USD', amountMinor: 1100 }, basis: 'ledger-row-instrument' }) },
      { kind: 'card', data_json: JSON.stringify({ method: { kind: 'card', network: 'visa', last4: '9001' },
        money: { currency: 'USD', amountMinor: 1100 }, basis: 'ledger-row-instrument' }) }]);
    const order = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
    expect(order.refunds.map(r => r.destination).sort()).toEqual(['balance', 'card']);
  });
  it('backfills destinations and events for refunds imported before the additive tables, idempotently', async () => {
    const capture = withLedger(syntheticCapture(), [ledgerRefund()]);
    await importAmazonCapture(db(), capture, backup());
    const events = listRefundEvents(db());
    // Simulate a database last written by the previous importer: no destinations, no event tables.
    await backedUpWrite(db(), backup(), () => {
      db().prepare('DELETE FROM amazon_refund_destinations').run();
      db().exec('DROP TABLE amazon_refund_event_members; DROP TABLE amazon_refund_events;');
    }, () => undefined);
    expect(hasRefundEventSchema(db())).toBe(false);
    expect(listRefundEvents(db())).toEqual([]);
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.refunds[0].destination).toBe('unknown');
    await importAmazonCapture(db(), structuredClone(capture), backup());
    expect(hasRefundEventSchema(db())).toBe(true);
    expect(listRefundEvents(db())).toEqual(events);
    expect(count('SELECT count(*) FROM amazon_refund_destinations')).toBe(1);
    await importAmazonCapture(db(), structuredClone(capture), backup());
    expect(count('SELECT count(*) FROM amazon_refund_destinations')).toBe(1);
  });
});
