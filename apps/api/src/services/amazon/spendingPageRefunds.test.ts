import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, importAmazonCapture } from './importer.js';
import { syntheticCapture, syntheticEvidence, syntheticReturnsCapture, withRefundEvidence } from './fixtures.testSupport.js';
import { opaque, SOURCE } from './policy.js';
import { projectRefundEvents } from './refundEvents.js';
import { ensureAmazonSchema, hasRefundEventSchema } from './schema.js';
import { amazonSpending, type AmazonSpendingView } from './spending.js';
import type { Money, PaymentObservation, RefundEvidence, RefundEvidencePhrase, Staging } from './types.js';

// Entirely synthetic: invented order IDs, ASINs, titles, amounts and card endings.
const TODAY = '2026-10-19';
const ORDER = '000-0000001-0000001';
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
/** Three lines and 10% tax: A 1000 (refunded whole: 1100), B 2000 (2200), C 4000 (4400); 7700 in all. */
const LINES = [['SYNTH00001', 'Synthetic blue widget', 1000], ['SYNTH00002', 'Synthetic green gadget', 2000],
  ['SYNTH00003', 'Synthetic red gizmo', 4000]] as const;
const [A, B, C] = LINES.map(([asin]) => asin);
type Fixture = { structure: unknown; staging: Staging };

let dir: string, repo: SqliteStateRepo, backups: number, runs: number;
const db = () => repo.internalGetDb();
const runId = () => `00000000-0000-4000-8000-${String(++runs).padStart(12, '0')}`;
const save = (capture: Fixture) => importAmazonCapture(db(), structuredClone(capture), path.join(dir, `backup-${++backups}.db`));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
  backups = 0;
  runs = 100;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** The order as a capture reads it: its lines, its summary, and proof the list is complete. */
function orderCapture(change: (order: Staging['orders'][number]) => void = () => undefined): Fixture {
  const capture = syntheticCapture();
  capture.staging.runId = runId();
  const order = capture.staging.orders[0];
  order.items = LINES.map(([itemId, title, price], lineOrdinal) => ({ lineOrdinal, itemId, title, quantity: 1, unitPrice: usd(price) }));
  order.total = usd(7700);
  order.summary = [{ kind: 'items-subtotal', money: usd(7000) }, { kind: 'shipping', money: usd(0) },
    { kind: 'tax', money: usd(700) }, { kind: 'grand-total', money: usd(7700) }];
  order.itemProof = { complete: true, unknownLine: false, conflict: false };
  capture.staging.coverage.details.records = order.items.length;
  change(order);
  return capture;
}
/** The same reads again: a later run's distinct capture. */
const rerun = (capture: Fixture): Fixture => {
  const next = structuredClone(capture);
  next.staging.runId = runId();
  return next;
};
const refundTotal = (amount: number) => orderCapture(order => { order.refundSummary = usd(amount); });
function withLedger(capture: Fixture, amounts: number[]): Fixture {
  const s = capture.staging;
  s.payments.push(...amounts.map((amount, ordinal): PaymentObservation => ({ date: '2026-09-12', money: usd(-amount), kind: 'refund',
    status: 'completed', method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [ORDER], identity: 'native-row',
    provenance: { source: 'ledger', status: 'Refunded', page: 0, ordinal } })));
  const refunds = s.payments.filter(p => p.kind === 'refund').length + (s.refundEvidence ?? []).filter(r => r.kind === 'refund').length;
  s.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: s.payments.length, rejected: 0 };
  s.coverage.refunds = { status: 'partial', reason: 'budget', pages: 1, records: refunds, rejected: 0 };
  return capture;
}
/** A refund statement: only a completed one states money and a date (a pending one is expected, never money). */
const statement = (status: RefundEvidence['status'], amount: number | null) => (status === 'completed'
  ? { status, money: amount === null ? null : usd(amount) } : { status, money: null, date: null });
/** An order-details statement about one line; `ordinal` keeps several in one capture apart. */
const detailsRefund = (line: number, amount: number | null, ordinal = 0, phrase: RefundEvidencePhrase = 'refund-issued',
  status: RefundEvidence['status'] = 'completed') => syntheticEvidence({ kind: 'refund', ...statement(status, amount),
  items: [{ lineOrdinal: line, itemId: LINES[line][0], title: null, units: null }],
  provenance: { source: 'order-details', page: 0, ordinal, phrase } } as Partial<RefundEvidence>);
/** A Returns-page refund naming its items by ASIN. */
const returnsRefund = (asins: string[], amount: number | null, ordinal = 0, phrase: RefundEvidencePhrase = 'refund-issued',
  status: RefundEvidence['status'] = 'completed') => syntheticEvidence({ kind: 'refund', ...statement(status, amount),
  items: asins.map(itemId => ({ lineOrdinal: null, itemId, title: null, units: null })),
  provenance: { source: 'returns-page', page: 0, ordinal, phrase } } as Partial<RefundEvidence>);
const returnsCapture = (records: RefundEvidence[]): Fixture => {
  const capture = syntheticReturnsCapture(records) as Fixture;
  capture.staging.runId = runId();
  return capture;
};
/** The owner's categories for the order's current lines: A and B at home, C in the office. */
function categorize() {
  const lines = db().prepare(`SELECT i.ref,json_extract(i.data_json,'$.itemId') AS itemId FROM amazon_items i
    JOIN amazon_orders o ON o.ref=i.order_ref WHERE i.native_line_id LIKE o.latest_digest || ':%'`).all() as Array<{ ref: string; itemId: string }>;
  for (const line of lines) {
    db().prepare('INSERT OR REPLACE INTO amazon_item_overrides VALUES(?,?)').run(line.ref, line.itemId === C ? 'Synthetic Office' : 'Synthetic Home');
  }
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const named = <K extends string>(list: ReadonlyArray<Record<K, string> & { orders?: number; count?: number }>, key: K) =>
  Object.fromEntries(list.filter(entry => (entry.orders ?? entry.count) !== 0)
    .map(entry => [entry[key], entry.orders ?? entry.count ?? 0])) as Record<string, number>;
let parse: ((raw: unknown, window: string) => unknown) | undefined;
/**
 * The window's spending, read without writing (no change counted, no schema touched), checked to add up: per item,
 * per category and in total gross less refunds is net, nothing takes off more than its gross or than was refunded,
 * and the page's own reader accepts it whole.
 */
async function read(): Promise<AmazonSpendingView> {
  const schema = db().prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  const changes = db().prepare('SELECT total_changes()').pluck().get();
  const view = amazonSpending(db(), '2Y', TODAY);
  expect(db().prepare('SELECT total_changes()').pluck().get()).toBe(changes);
  expect(db().prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  for (const total of view.totals) {
    expect(total.netItemMinor).toBe(total.itemMinor - total.itemRefundMinor - total.unattributedRefundMinor);
    expect(total.netItemMinor).toBeGreaterThanOrEqual(0);
    expect(total.itemRefundMinor + total.unattributedRefundMinor).toBeLessThanOrEqual(total.refundMinor);
    const categories = view.categories.filter(category => category.currency === total.currency);
    expect(sum(categories.map(category => category.amountMinor))).toBe(total.itemMinor);
    expect(sum(categories.map(category => category.refundMinor))).toBe(total.itemRefundMinor);
    expect(sum(view.products.filter(p => p.currency === total.currency).map(p => p.refundMinor))).toBe(total.itemRefundMinor);
  }
  for (const entry of [...view.categories, ...view.products]) {
    expect(entry.netMinor).toBe(entry.amountMinor - entry.refundMinor);
    expect(entry.refundMinor).toBeGreaterThanOrEqual(0);
    expect(entry.refundMinor).toBeLessThanOrEqual(entry.amountMinor);
  }
  const orders = named(view.refunds.orders, 'basis');
  expect(sum(Object.values(orders))).toBe(view.orders.refunded);
  expect(sum(view.refunds.sources.map(entry => entry.orders))).toBe(view.orders.refunded);
  expect(sum(view.refunds.unattributed.map(entry => entry.orders))).toBe((orders.partly ?? 0) + (orders.unattributed ?? 0));
  if (!parse) {
    const href = new URL('../../../../web/src/components/amazon/amazonApi.ts', import.meta.url).href;
    parse = (await import(/* @vite-ignore */ href) as { parseAmazonSpending: typeof parse }).parseAmazonSpending;
  }
  expect(() => parse!(JSON.parse(JSON.stringify(view)), '2Y')).not.toThrow();
  return view;
}
/** One order per database: its totals are the order's. */
function outcome(view: AmazonSpendingView) {
  const [total] = view.totals;
  return {
    refund: total.refundMinor, itemRefund: total.itemRefundMinor, unattributed: total.unattributedRefundMinor, net: total.netItemMinor,
    items: Object.fromEntries(view.products.filter(p => p.refundMinor > 0).map(p => [p.asin, p.refundMinor])),
    categories: Object.fromEntries(view.categories.map(category => [category.category, category.netMinor])),
    basis: named(view.refunds.orders, 'basis'), source: named(view.refunds.sources, 'source'),
    excluded: named(view.refunds.excluded, 'reason'),
  };
}
const kept = { refund: 0, itemRefund: 0, unattributed: 0, net: 7000, items: {},
  categories: { 'Synthetic Home': 3000, 'Synthetic Office': 4000 }, basis: {}, source: {}, excluded: {} };
/** A refunded, its 1000 off at home; the Refund Total's 1100 counted once. */
const refundedA = { refund: 1100, itemRefund: 1000, unattributed: 0, net: 6000, items: { [A]: 1000 },
  categories: { 'Synthetic Home': 2000, 'Synthetic Office': 4000 }, excluded: {} };
const refundedB = { refund: 2200, itemRefund: 2000, unattributed: 0, net: 5000, items: { [B]: 2000 },
  categories: { 'Synthetic Home': 1000, 'Synthetic Office': 4000 }, excluded: {} };
const refundedAB = { refund: 3300, itemRefund: 3000, unattributed: 0, net: 4000, items: { [A]: 1000, [B]: 2000 },
  categories: { 'Synthetic Home': 0, 'Synthetic Office': 4000 }, excluded: {} };

describe('order-details and Returns-page refunds in Amazon spending', () => {
  it('nets a completed, fully refunded one-line order from order details alone, and from the Returns page alone', async () => {
    // The independent review's two cases: the synthetic one-line order (1000 + 100 tax), refunded whole.
    const one = () => {
      const capture = syntheticCapture();
      capture.staging.runId = runId();
      capture.staging.orders[0].itemProof = { complete: true, unknownLine: false, conflict: false };
      return capture;
    };
    await save(withRefundEvidence(one(), [syntheticEvidence()]));
    expect((await read()).totals[0]).toMatchObject({ itemMinor: 1000, refundMinor: 1100, itemRefundMinor: 1000, netItemMinor: 0 });
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
    repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
    await save(one());
    await save(returnsCapture([syntheticEvidence({ provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'refund-issued' },
      items: [{ lineOrdinal: null, itemId: 'SYNTH00001', title: null, units: null }] })]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ itemMinor: 1000, refundMinor: 1100, itemRefundMinor: 1000, netItemMinor: 0 });
    expect(view.refunds.pageEvents).toEqual({ policy: 'amazon-refund-event-netting-v1', events: 1, observations: 1, orders: 1,
      held: ['order-total-missing', 'currency-mismatch', 'contradictory', 'item-unmapped', 'exceeds-order-total',
        'exceeds-item-charge'].map(reason => ({ reason, orders: 0 })), conflicts: [{ reason: 'refund-status-regressed', orders: 0 }] });
  });

  // Each case: the captures imported in turn, then what the order's refund comes to. Every refund counts once.
  const cases: Array<[string, () => Fixture[], Record<string, unknown>]> = [
    ['nothing refunded', () => [orderCapture()], kept],
    ['S only: the Refund Total', () => [refundTotal(1100)],
      { ...refundedA, basis: { units: 1 }, source: { 'order-summary': 1 } }],
    ['L only: a ledger refund', () => [withLedger(orderCapture(), [1100])],
      { ...refundedA, basis: { units: 1 }, source: { ledger: 1 } }],
    ['D only: order details', () => [withRefundEvidence(orderCapture(), [detailsRefund(0, 1100)])],
      { ...refundedA, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['R only: the Returns page', () => [orderCapture(), returnsCapture([returnsRefund([B], 2200)])],
      { ...refundedB, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['S+D: one refund seen twice', () => [withRefundEvidence(refundTotal(1100), [detailsRefund(0, 1100)])],
      { ...refundedA, basis: { 'item-records': 1 }, source: { 'order-summary': 1 } }],
    ['S+R: one refund seen twice', () => [refundTotal(2200), returnsCapture([returnsRefund([B], 2200)])],
      { ...refundedB, basis: { 'item-records': 1 }, source: { 'order-summary': 1 } }],
    ['S+L+D+R: one refund seen four times', () => [withLedger(withRefundEvidence(refundTotal(1100), [detailsRefund(0, 1100)]), [1100]),
      returnsCapture([returnsRefund([A], 1100)])],
    { ...refundedA, basis: { 'item-records': 1 }, source: { 'order-summary': 1 } }],
    ['D+R for the same item', () => [withRefundEvidence(orderCapture(), [detailsRefund(0, 1100)]), returnsCapture([returnsRefund([A], 1100)])],
      { ...refundedA, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['D+R for different items', () => [withRefundEvidence(orderCapture(), [detailsRefund(0, 1100)]), returnsCapture([returnsRefund([B], 2200)])],
      { ...refundedAB, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['a later R refund beyond S', () => [refundTotal(1100), returnsCapture([returnsRefund([A], 1100), returnsRefund([B], 2200, 1)])],
      { ...refundedAB, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['S beyond R: v1 ties the rest over the units left', () => [refundTotal(3300), returnsCapture([returnsRefund([B], 2200)])],
      { ...refundedAB, basis: { 'item-records': 1 }, source: { 'order-summary': 1 } }],
    ['over the order\'s total: held, never counted', () => [withRefundEvidence(orderCapture(), [detailsRefund(0, 7800)])],
      { ...kept, excluded: { 'exceeds-order-total': 1 } }],
    ['over the order\'s total with a Refund Total: held whole', () => [withRefundEvidence(refundTotal(1100), [detailsRefund(0, 7800)])],
      { ...kept, refund: 1100, unattributed: 1100, net: 5900, basis: { unattributed: 1 }, source: { 'order-summary': 1 },
        excluded: { 'exceeds-order-total': 1 } }],
    ['over an item\'s charge: held whole', () => [refundTotal(1100), returnsCapture([returnsRefund([A], 1103)])],
      { ...kept, refund: 1100, unattributed: 1100, net: 5900, basis: { unattributed: 1 }, source: { 'order-summary': 1 },
        excluded: { contradictory: 1 } }],
    ['at an item\'s charge: its price plus its tax share, within rounding', () => [refundTotal(1100), returnsCapture([returnsRefund([A], 1102)])],
      { ...refundedA, refund: 1102, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['a partial refund: exactly its cents off the item', () => [orderCapture(), returnsCapture([returnsRefund([B], 600)])],
      { ...kept, refund: 600, itemRefund: 600, net: 6400, items: { [B]: 600 }, categories: { 'Synthetic Home': 2400, 'Synthetic Office': 4000 },
        basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['the same item by both sources at different amounts: the larger, never the sum', () => [
      withRefundEvidence(orderCapture(), [detailsRefund(1, 600)]), returnsCapture([returnsRefund([B], 2200)])],
    { ...refundedB, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['an item the order does not have: held whole', () => [refundTotal(1100), returnsCapture([returnsRefund(['SYNTH00009'], 1100)])],
      { ...kept, refund: 1100, unattributed: 1100, net: 5900, basis: { unattributed: 1 }, source: { 'order-summary': 1 },
        excluded: { unresolved: 1 } }],
    ['an amount that went down: held whole', () => [withRefundEvidence(refundTotal(1100), [detailsRefund(0, 1100)]),
      withRefundEvidence(rerun(refundTotal(1100)), [detailsRefund(0, 900)])],
    { ...kept, refund: 1100, unattributed: 1100, net: 5900, basis: { unattributed: 1 }, source: { 'order-summary': 1 },
      excluded: { contradictory: 1 } }],
    ['an amount that went up: the latest', () => [withRefundEvidence(orderCapture(), [detailsRefund(0, 600)]),
      withRefundEvidence(rerun(orderCapture()), [detailsRefund(0, 1100)])],
    { ...refundedA, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['a pending refund never counts', () => [orderCapture(), returnsCapture([returnsRefund([A], 1100, 0, 'refund-pending', 'pending')])], kept],
    ['an expected "Refund for this return" amount (pending) never counts', () => [withRefundEvidence(orderCapture(),
      [detailsRefund(0, 1100, 0, 'refund-for-return', 'pending')])], kept],
    ['a refund issued, then shown pending, stays counted (the step back is surfaced)', () => [
      withRefundEvidence(orderCapture(), [detailsRefund(0, 1100)]),
      withRefundEvidence(rerun(orderCapture()), [detailsRefund(0, 1100, 0, 'refund-pending', 'pending')])],
    { ...refundedA, basis: { 'item-records': 1 }, source: { 'item-records': 1 } }],
    ['a completed return is not a refund', () => [withRefundEvidence(orderCapture(), [syntheticEvidence({ kind: 'return', status: 'completed',
      money: null, provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'return-complete' } } as Partial<RefundEvidence>)])], kept],
  ];
  it.each(cases)('%s', async (_name, captures, expected) => {
    for (const capture of captures()) await save(capture);
    categorize();
    expect(outcome(await read())).toEqual({ ...kept, ...expected });
  });

  it('says how many page events it counted and why it held, only when there are any', async () => {
    await save(orderCapture());
    await save(returnsCapture([returnsRefund([A], 1100, 0, 'refund-pending', 'pending')]));
    expect((await read()).refunds).not.toHaveProperty('pageEvents');
    await save(withRefundEvidence(refundTotal(1100), [detailsRefund(0, 1100)]));
    await save(returnsCapture([returnsRefund(['SYNTH00009'], 1100)]));
    const { pageEvents } = (await read()).refunds;
    expect(pageEvents).toMatchObject({ events: 2, observations: 2, orders: 1 });
    expect(named(pageEvents!.held, 'reason')).toEqual({ 'item-unmapped': 1 });
  });

  it('counts repeated imports and later runs of the same statements once', async () => {
    const details = withRefundEvidence(refundTotal(1100), [detailsRefund(0, 1100)]);
    const returns = returnsCapture([returnsRefund([B], 2200)]);
    await save(details);
    await save(returns);
    categorize();
    const once = await read();
    expect(outcome(once)).toEqual({ ...kept, ...refundedAB, basis: { 'item-records': 1 }, source: { 'item-records': 1 } });
    // The same captures again add nothing; later runs showing the same statements are the same refunds.
    expect(await save(details)).toMatchObject({ newCaptures: 0, newObservations: 0 });
    await save(returns);
    await save(rerun(details));
    await save(rerun(returns));
    categorize();
    const again = await read();
    expect(outcome(again)).toEqual(outcome(once));
    expect(again.refunds.pageEvents).toMatchObject({ events: 2, observations: 4, orders: 1 });
    expect(again.refunds).toMatchObject({ refundTotals: 1, refundTotalObservations: 2 });
  });

  it('answers the same whatever order the captures and their records come in', async () => {
    const details = (order: number[]) => withLedger(withRefundEvidence(refundTotal(1100),
      order.map(n => [detailsRefund(0, 1100, 0), detailsRefund(2, null, 1)][n])), [1100]);
    const returns = (order: number[]) => returnsCapture(order.map(n => [returnsRefund([A], 1100, 0), returnsRefund([B], 2200, 1)][n]));
    const answers: unknown[] = [];
    for (const [first, records] of [[0, [0, 1]], [1, [1, 0]], [0, [1, 0]], [1, [0, 1]]] as Array<[number, number[]]>) {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
      repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
      const captures = [details(records), returns(records)];
      for (const capture of first ? captures.reverse() : captures) await save(capture);
      categorize();
      answers.push(outcome(await read()));
    }
    // A and B by both page sources, C stated refunded without money and not counted beyond: 3300, once.
    expect(answers[0]).toEqual({ ...kept, ...refundedAB, basis: { 'item-records': 1 }, source: { 'item-records': 1 } });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('names a line by its ASIN when the statement was read with another capture\'s lines, and by title without one', async () => {
    // Order details said A was refunded; the same order, read again later without that statement, is now displayed.
    await save(withRefundEvidence(orderCapture(), [detailsRefund(0, 1100)]));
    await save(orderCapture());
    expect(db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get())
      .toBe(db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid DESC LIMIT 1').pluck().get());
    categorize();
    expect(outcome(await read())).toMatchObject({ refund: 1100, items: { [A]: 1000 } });
    // A re-read listing the lines in another order, without proving its item list complete, conflicts with the displayed
    // order (line order is a fact unless a complete re-read proves it only a reorder: Root, 2026-11-23), so it stays
    // history only; its statements name its own lines. Their ordinals would name other lines of the displayed order (C as
    // A, B as C).
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
    repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
    const noAsin = (order: Staging['orders'][number]) => { order.items[1].itemId = null; };
    const shown = orderCapture(noAsin);
    await save(shown);
    const reordered = withRefundEvidence(orderCapture(order => {
      noAsin(order);
      order.items = [order.items[2], order.items[0], order.items[1]].map((item, lineOrdinal) => ({ ...item, lineOrdinal }));
      order.itemProof = { complete: false, unknownLine: true, conflict: false };
    }), [syntheticEvidence({ money: usd(4400), items: [{ lineOrdinal: 0, itemId: C, title: null, units: null }] }),
      syntheticEvidence({ money: usd(2200), items: [{ lineOrdinal: 2, itemId: null, title: null, units: null }],
        provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: 'refund-issued' } })]);
    await save(reordered);
    const displayed = db().prepare('SELECT latest_digest FROM amazon_orders').pluck().all();
    expect(displayed).toHaveLength(1);
    expect(db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid LIMIT 1').pluck().get()).toBe(displayed[0]);
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 6600, itemRefundMinor: 6000, unattributedRefundMinor: 0, netItemMinor: 1000 });
    expect(view.products.filter(p => p.refundMinor > 0).map(p => [p.title, p.refundMinor]).sort())
      .toEqual([['Synthetic green gadget', 2000], ['Synthetic red gizmo', 4000]]);
    expect(view.refunds.pageEvents).toMatchObject({ events: 2, orders: 1 });
    expect(named(view.refunds.pageEvents!.held, 'reason')).toEqual({});
  });

  it('takes a complete re-read listing the lines in another order as the display, its statements naming its own lines (Root, 2026-11-23)', async () => {
    // Line order is not a fact: the same re-read, proving its item list complete, replaces the display, and the same
    // statements now name the displayed order's own lines by their ordinals: the same refunds, on the same products.
    const noAsin = (order: Staging['orders'][number]) => { order.items[1].itemId = null; };
    await save(orderCapture(noAsin));
    await save(withRefundEvidence(orderCapture(order => {
      noAsin(order);
      order.items = [order.items[2], order.items[0], order.items[1]].map((item, lineOrdinal) => ({ ...item, lineOrdinal }));
    }), [syntheticEvidence({ money: usd(4400), items: [{ lineOrdinal: 0, itemId: C, title: null, units: null }] }),
      syntheticEvidence({ money: usd(2200), items: [{ lineOrdinal: 2, itemId: null, title: null, units: null }],
        provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: 'refund-issued' } })]));
    expect(db().prepare('SELECT latest_digest FROM amazon_orders').pluck().all())
      .toEqual([db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid DESC LIMIT 1').pluck().get()]);
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 6600, itemRefundMinor: 6000, unattributedRefundMinor: 0, netItemMinor: 1000 });
    expect(view.products.filter(p => p.refundMinor > 0).map(p => [p.title, p.refundMinor]).sort())
      .toEqual([['Synthetic green gadget', 2000], ['Synthetic red gizmo', 4000]]);
    expect(view.refunds.pageEvents).toMatchObject({ events: 2, orders: 1 });
    expect(named(view.refunds.pageEvents!.held, 'reason')).toEqual({});
  });

  it('reads exactly as before #155\'s tables exist, and never creates them', async () => {
    await save(withLedger(withRefundEvidence(refundTotal(1100), [detailsRefund(1, 2200, 0)]), [1100]));
    categorize();
    // The Refund Total and the ledger say 1100, order details 2200 for B: the larger counts, never their sum.
    expect(outcome(await read())).toMatchObject({ refund: 2200, items: { [B]: 2000 } });
    // A database last written before the event tables: the Refund Total and the ledger alone, as on main.
    await backedUpWrite(db(), path.join(dir, `backup-${++backups}.db`), () => {
      db().exec('DROP TABLE amazon_refund_event_members; DROP TABLE amazon_refund_events;');
    }, () => undefined);
    expect(hasRefundEventSchema(db())).toBe(false);
    const before = await read();
    expect(before.refunds).not.toHaveProperty('pageEvents');
    expect(outcome(before)).toEqual({ ...kept, ...refundedA, basis: { units: 1 }, source: { 'order-summary': 1 } });
    expect(hasRefundEventSchema(db())).toBe(false);
  });

  it('answers byte for byte as without the event tables when no page refund was issued', async () => {
    await save(withLedger(withRefundEvidence(refundTotal(3300), [detailsRefund(0, 1100, 0, 'refund-pending', 'pending'),
      syntheticEvidence({ kind: 'return', status: 'started', money: null, items: [],
        provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: 'return-started' } } as Partial<RefundEvidence>)]), [1100]));
    await save(returnsCapture([returnsRefund([C], 4400, 0, 'refund-pending', 'pending')]));
    categorize();
    const withTables = JSON.stringify(await read());
    await backedUpWrite(db(), path.join(dir, `backup-${++backups}.db`), () => {
      db().exec('DROP TABLE amazon_refund_event_members; DROP TABLE amazon_refund_events;');
    }, () => undefined);
    expect(JSON.stringify(await read())).toBe(withTables);
  });

  it('never adds a card credit to Amazon\'s refunds', async () => {
    await save(withRefundEvidence(refundTotal(1100), [detailsRefund(0, 1100)]));
    categorize();
    const before = outcome(await read());
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', nickname: 'Synthetic Prime Visa' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      { transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 7700, currency: 'USD', description: 'AMAZON MKTPL*SYNTH1',
        issuerCategory: 'Shopping' },
      { transactionDate: '2026-09-12', status: 'posted', kind: 'refund', amountMinor: -3300, currency: 'USD', description: 'AMAZON MKTPL*SYNTH1',
        issuerCategory: 'Shopping' }] });
    expect(outcome(await read())).toEqual(before);
  });
});

describe('a page refund in another currency than its order, and one never issued', () => {
  it('holds the order whole and counts nothing of it; a stated amount without an issued status never counts', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
        CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
          user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
      ensureAmazonSchema(db);
      const eur = (amountMinor: number): Money => ({ currency: 'EUR', amountMinor });
      const orderId = '000-0000002-0000002', orderRef = opaque('order', orderId);
      db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
      db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run('capture-eur', SOURCE, 3, '2026-08-21', TODAY, '{}', '{}', TODAY, '{}');
      const order = { orderId, date: '2026-09-01', total: eur(1100),
        items: [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: 'Synthetic euro widget', quantity: 1, unitPrice: eur(1000) }],
        summary: [{ kind: 'items-subtotal', money: eur(1000) }, { kind: 'shipping', money: eur(0) }, { kind: 'tax', money: eur(100) },
          { kind: 'grand-total', money: eur(1100) }], itemProof: { complete: true, unknownLine: false, conflict: false } };
      db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef, SOURCE, orderId, 'capture-eur', JSON.stringify(order));
      db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(opaque('line-observation', ['capture-eur', orderId, 0]), orderRef,
        'capture-eur:0', JSON.stringify(order.items[0]));
      const statement = syntheticEvidence({ orderIds: [orderId], money: usd(1100),
        items: [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: null, units: null }] });
      db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', ['capture-eur', 'refund', 1000]),
        'capture-eur', 'refund', 1000, orderRef, 'refund-evidence-unattributed', JSON.stringify(statement));
      projectRefundEvents(db);
      const view = amazonSpending(db, '60D', TODAY);
      expect(view.totals).toEqual([{ currency: 'EUR', orderTotalMinor: 1100, itemsCompleteOrderTotalMinor: 1100, itemMinor: 1000,
        categorizedMinor: 0, refundMinor: 0, itemRefundMinor: 0, unattributedRefundMinor: 0, netItemMinor: 1000 }]);
      expect(named(view.refunds.excluded, 'reason')).toEqual({ 'currency-mismatch': 1 });
      expect(named(view.refunds.pageEvents!.held, 'reason')).toEqual({ 'currency-mismatch': 1 });
      // A stated "Refund for this return" amount an earlier importer stored as completed is still never an issued refund.
      db.exec('DELETE FROM amazon_refund_event_members; DELETE FROM amazon_refund_events; DELETE FROM amazon_observations;');
      db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', ['capture-eur', 'refund', 1000]),
        'capture-eur', 'refund', 1000, orderRef, 'refund-evidence-unattributed', JSON.stringify({ ...statement, money: eur(1100),
          provenance: { ...statement.provenance, phrase: 'refund-for-return' } }));
      projectRefundEvents(db);
      expect(db.prepare("SELECT count(*) FROM amazon_refund_events WHERE status='completed'").pluck().get()).toBe(1);
      const quoted = amazonSpending(db, '60D', TODAY);
      expect(quoted.totals[0]).toMatchObject({ refundMinor: 0, netItemMinor: 1000 });
      expect(quoted.refunds).not.toHaveProperty('pageEvents');
    } finally { db.close(); }
  });
});

describe('independent review repros: identity, per-statement caps and exact cents', () => {
  /** A cart as a capture reads it: one unit at each price, its tax and shipping, ASINs SYNTH00001… unless left out. */
  function cart(prices: number[], options: { tax?: number; shipping?: number; asins?: boolean; quantities?: number[] } = {}): Fixture {
    const capture = syntheticCapture() as Fixture;
    capture.staging.runId = runId();
    const order = capture.staging.orders[0];
    const tax = options.tax ?? 0, shipping = options.shipping ?? 0;
    const quantity = (i: number) => options.quantities?.[i] ?? 1;
    const subtotal = prices.reduce((n, price, i) => n + price * quantity(i), 0);
    order.items = prices.map((price, lineOrdinal) => ({ lineOrdinal, itemId: options.asins === false ? null : `SYNTH${String(lineOrdinal + 1).padStart(5, '0')}`,
      title: `Synthetic cart item ${lineOrdinal}`, quantity: quantity(lineOrdinal), unitPrice: usd(price) }));
    order.total = usd(subtotal + tax + shipping);
    order.summary = [{ kind: 'items-subtotal', money: usd(subtotal) }, { kind: 'shipping', money: usd(shipping) },
      { kind: 'tax', money: usd(tax) }, { kind: 'grand-total', money: usd(subtotal + tax + shipping) }];
    order.itemProof = { complete: true, unknownLine: false, conflict: false };
    capture.staging.coverage.details.records = prices.length;
    return capture;
  }
  const said = (lines: Array<{ lineOrdinal: number | null; itemId: string | null; title?: string | null; units?: number | null }>,
    amount: number | null, source: 'order-details' | 'returns-page' = 'order-details', ordinal = 0) => syntheticEvidence({
    money: amount === null ? null : usd(amount), date: source === 'returns-page' ? null : '2026-09-10',
    items: lines.map(entry => ({ lineOrdinal: entry.lineOrdinal, itemId: entry.itemId, title: entry.title ?? null, units: entry.units ?? null })),
    provenance: { source, page: 0, ordinal, phrase: 'refund-issued' } });
  const heldOrders = (view: AmazonSpendingView) => named(view.refunds.pageEvents?.held ?? [], 'reason');

  it('keeps two items apart when a reordered re-read names another item at the same position', async () => {
    const first = cart([1000, 2000, 4000], { asins: false });
    await save(withRefundEvidence(first, [said([{ lineOrdinal: 0, itemId: null }], 1000)]));
    const second = cart([1000, 2000, 4000], { asins: false });
    const lines = second.staging.orders[0].items;
    second.staging.orders[0].items = [lines[1], lines[0], lines[2]].map((item, lineOrdinal) => ({ ...item, lineOrdinal }));
    await save(withRefundEvidence(second, [said([{ lineOrdinal: 0, itemId: null }], 2000)]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 3000, itemRefundMinor: 3000, netItemMinor: 4000 });
    expect(view.products.filter(p => p.refundMinor > 0).map(p => [p.title, p.refundMinor]).sort())
      .toEqual([['Synthetic cart item 0', 1000], ['Synthetic cart item 1', 2000]]);
    expect(heldOrders(view)).toEqual({});
  });

  it('counts one refund once when its item later shows an ASIN, on order details and on the Returns page', async () => {
    const plain = cart([1000, 4000]);
    plain.staging.orders[0].items[0].itemId = null;
    await save(withRefundEvidence(plain, [said([{ lineOrdinal: 0, itemId: null }], 500)]));
    expect((await read()).totals[0].refundMinor).toBe(500);
    const enriched = cart([1000, 4000]);
    await save(withRefundEvidence(enriched, [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }], 500)]));
    expect((await read()).totals[0]).toMatchObject({ refundMinor: 500, itemRefundMinor: 500 });
    await save(returnsCapture([said([{ lineOrdinal: null, itemId: null, title: 'Synthetic cart item 1' }], 1500, 'returns-page')]));
    await save(returnsCapture([said([{ lineOrdinal: null, itemId: 'SYNTH00002' }], 1500, 'returns-page')]));
    expect((await read()).totals[0]).toMatchObject({ refundMinor: 2000, itemRefundMinor: 2000 });
  });

  it('holds a statement over its own item\'s charge, whatever larger statement names more items', async () => {
    await save(withRefundEvidence(cart([1000, 9000, 10000]), [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }], 5000)]));
    await save(returnsCapture([said([{ lineOrdinal: null, itemId: 'SYNTH00001' }, { lineOrdinal: null, itemId: 'SYNTH00002' }], 10000,
      'returns-page')]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 0, netItemMinor: 20000 });
    expect(heldOrders(view)).toEqual({ 'exceeds-item-charge': 1 });
  });

  it('caps a named item at its price plus its tax share when known, else at its price', async () => {
    await save(withRefundEvidence(cart([1000, 9000], { tax: 1000 }), [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }], 1900)]));
    expect(heldOrders(await read())).toEqual({ 'exceeds-item-charge': 1 });
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
    repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
    const unknown = cart([1000, 9000]);
    const order = unknown.staging.orders[0];
    order.summary = [];
    order.itemProof = { complete: false, unknownLine: true, conflict: false };
    order.tenderCoverage = 'unknown';
    order.tenderProof!.summaryComplete = false;
    await save(withRefundEvidence(unknown, [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }], 1001)]));
    expect(heldOrders(await read())).toEqual({ 'exceeds-item-charge': 1 });
  });

  it('adds order-level statements of one source seen together in one capture, never the same statement twice', async () => {
    const both = withRefundEvidence(cart([1000, 9000, 10000]), [said([], 1000, 'order-details', 0), said([], 2000, 'order-details', 1)]);
    await save(both);
    expect((await read()).totals[0].refundMinor).toBe(3000);
    // A later run showing the same two statements: still two refunds, not four.
    const again = structuredClone(both);
    again.staging.runId = runId();
    await save(again);
    const view = await read();
    expect(view.totals[0].refundMinor).toBe(3000);
    expect(view.refunds.pageEvents).toMatchObject({ events: 2, observations: 4 });
  });

  it('holds when statements seen together in one capture add up to more than the order cost', async () => {
    const order = cart([1000, 9000]);
    order.staging.orders[0].refundSummary = usd(1000);
    await save(withRefundEvidence(order, [said([], 6000, 'order-details', 0), said([], 6000, 'order-details', 1)]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 1000, itemRefundMinor: 0, unattributedRefundMinor: 1000 });
    expect(heldOrders(view)).toEqual({ 'exceeds-order-total': 1 });
  });

  it('keeps an item\'s proven amount inside a larger bundle: only the bundle\'s excess goes to its other items', async () => {
    await save(withRefundEvidence(cart([1000, 1000, 5000]), [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }], 900)]));
    await save(returnsCapture([said([{ lineOrdinal: null, itemId: 'SYNTH00001' }, { lineOrdinal: null, itemId: 'SYNTH00002' }], 1000,
      'returns-page')]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 1000, itemRefundMinor: 1000 });
    expect(view.products.filter(p => p.refundMinor > 0).map(p => [p.asin, p.refundMinor]).sort())
      .toEqual([['SYNTH00001', 900], ['SYNTH00002', 100]]);
  });

  it('follows a refund on its stable line across identities: a step back stays counted and is surfaced, a decrease holds', async () => {
    const titleOnly = () => said([{ lineOrdinal: null, itemId: null, title: 'Synthetic cart item 0' }], 1000, 'returns-page');
    await save(cart([1000, 1000, 5000]));
    await save(returnsCapture([titleOnly()]));
    const pending = said([{ lineOrdinal: null, itemId: 'SYNTH00001' }], null, 'returns-page');
    Object.assign(pending, { status: 'pending', provenance: { ...pending.provenance, phrase: 'refund-pending' } });
    await save(returnsCapture([pending]));
    const stepped = await read();
    expect(stepped.totals[0]).toMatchObject({ refundMinor: 1000, itemRefundMinor: 1000 });
    expect(stepped.refunds.pageEvents).toMatchObject({ conflicts: [{ reason: 'refund-status-regressed', orders: 1 }] });
    expect(heldOrders(stepped)).toEqual({});
    // A later smaller completed amount on the same line, under its ASIN this time: contradictory, held.
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
    repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
    await save(cart([1000, 1000, 5000]));
    await save(returnsCapture([titleOnly()]));
    await save(returnsCapture([said([{ lineOrdinal: null, itemId: 'SYNTH00001' }], 500, 'returns-page')]));
    const decreased = await read();
    expect(decreased.totals[0].refundMinor).toBe(0);
    expect(heldOrders(decreased)).toEqual({ contradictory: 1 });
  });

  it('never takes off more cents than were refunded: 999 refunded is 999 off', async () => {
    await save(withRefundEvidence(cart([1000, 1000], { tax: 1 }), [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }], 999)]));
    expect((await read()).totals[0]).toMatchObject({ refundMinor: 999, itemRefundMinor: 999, unattributedRefundMinor: 0, netItemMinor: 1001 });
  });

  it('takes a bundle at or below its items\' prices off them to the cent, whatever their tax shares', async () => {
    // Two units of a 1¢ item and a 100¢ item, tax 100: 101 refunded for both is 101 off them, not 98 and 3 of tax.
    await save(withRefundEvidence(cart([1, 100, 1000], { tax: 100, quantities: [2, 1, 1] }),
      [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' }, { lineOrdinal: 1, itemId: 'SYNTH00002' }], 101)]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 101, itemRefundMinor: 101, unattributedRefundMinor: 0, netItemMinor: 1001 });
    expect(view.products.filter(p => p.refundMinor > 0).map(p => [p.asin, p.refundMinor]).sort())
      .toEqual([['SYNTH00001', 2], ['SYNTH00002', 99]]);
    // Uneven items, tax and shipping: below, at and above their prices. Only cents above them are tax and shipping.
    for (const [money, item] of [[101, 101], [102, 102], [103, 102]]) {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-page-refunds-synthetic-'));
      repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
      await save(withRefundEvidence(cart([1, 1, 100], { tax: 50, shipping: 50 }), [said([{ lineOrdinal: 0, itemId: 'SYNTH00001' },
        { lineOrdinal: 1, itemId: 'SYNTH00002' }, { lineOrdinal: 2, itemId: 'SYNTH00003' }], money)]));
      expect((await read()).totals[0]).toMatchObject({ refundMinor: money, itemRefundMinor: item, unattributedRefundMinor: 0,
        netItemMinor: 102 - item });
    }
  });

  it('keeps per-item amounts that units prove when sources report at different granularity', async () => {
    await save(withRefundEvidence(cart([1000, 1000, 5000], { quantities: [2, 1, 1] }),
      [said([{ lineOrdinal: 0, itemId: 'SYNTH00001', units: 2 }], 2000)]));
    await save(returnsCapture([said([{ lineOrdinal: null, itemId: 'SYNTH00001', units: 1 }, { lineOrdinal: null, itemId: 'SYNTH00002', units: 1 }],
      2000, 'returns-page')]));
    const view = await read();
    expect(view.totals[0]).toMatchObject({ refundMinor: 3000, itemRefundMinor: 3000, netItemMinor: 5000 });
    expect(heldOrders(view)).toEqual({});
  });
});
