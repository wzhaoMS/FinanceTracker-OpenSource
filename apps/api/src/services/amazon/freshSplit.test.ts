import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { readLedger } from './matcher.js';
import { opaque } from './policy.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { FRESH_DEFAULT_CARD_CATEGORY } from './freshItems.js';
import { freshSplit, readFreshSplitOrders, type FreshSplitLine, type FreshSplitOrder } from './freshSplit.js';
import { rootApproval, syntheticCapture, syntheticRow, syntheticSubject } from './fixtures.testSupport.js';
import type { LedgerRow, MatchSubject, Resolution } from './types.js';

// Amazon Fresh split policy (Root's GO 2026-11-22). Entirely synthetic: invented order IDs, titles, card endings and amounts.
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const GROCERIES = FRESH_DEFAULT_CARD_CATEGORY, PHARMACY = 'Synthetic Pharmacy';
const ORDER_ID = '000-0000001-0000001', ORDER = opaque('order', ORDER_ID);
const line = (n: number, weight: number, category = GROCERIES, categorySource: FreshSplitLine['categorySource'] = 'item-taxonomy'):
  FreshSplitLine => ({ ref: opaque('fresh-line', ['synthetic', n]), tie: opaque('fresh-line-identity', ['synthetic', n]), weight,
  category, categorySource, title: `Synthetic fresh item ${n}`, asin: null, quantity: 1 });
/** A Fresh order whose $10.00 of lines reconcile: $6.00 of groceries, $3.00 of pharmacy, $1.00 nobody classified. */
const order = (patch: Partial<FreshSplitOrder> = {}): FreshSplitOrder => ({ ref: ORDER, currency: 'USD', tip: 0,
  lines: [line(0, 600), line(1, 300, PHARMACY), line(2, 100, GROCERIES, 'fresh-default')], ...patch });
const household = new Set([GROCERIES, PHARMACY]);
const row = (amountMinor: number, patch: Partial<LedgerRow> = {}) =>
  syntheticRow({ id: 'synthetic-fresh-row', amountMinor, description: 'AMAZON.COM*SYNTH FRESH', ...patch });
const whole = (reason: Extract<Resolution, { kind: 'whole-row' }>['reason'] = 'item-identity-unproven'): Resolution =>
  ({ kind: 'whole-row', cardTransactionId: 'synthetic-fresh-row', reason });
const totalLink = (amountMinor: number, patch: Partial<MatchSubject> = {}) => syntheticSubject({ evidenceClass: 'unique-total-match',
  nativeOccurrenceId: null, provenance: 'order-total', money: usd(amountMinor), orderRefs: [ORDER],
  allocationHoldReason: 'item-identity-unproven', ...patch });
const orderPart = (amountMinor: number) => totalLink(amountMinor, { provenance: 'order-total-split',
  split: { part: 'order', totalRef: opaque('order-total', ORDER_ID) } });
const ledgerLink = (amountMinor: number, patch: Partial<MatchSubject> = {}) => syntheticSubject({
  evidenceClass: 'payment-ledger-complete', money: usd(amountMinor), orderRefs: [ORDER], ...patch });
const split = (r: LedgerRow, s: MatchSubject, o = order(), categories = household, resolution = whole()) =>
  freshSplit(r, s, resolution, new Map([[o.ref, o]]), categories);
const parts = (resolution: ReturnType<typeof split>) =>
  resolution?.contributions.map(p => [p.itemRef ?? null, p.amountMinor, p.category, p.categorySource, p.classification]);

describe('Amazon Fresh split policy: a linked charge split over its Item List lines (freshSplit)', () => {
  it('splits an order-total charge over the delivered lines by list price, each under its line\'s card category', () => {
    // $11.00: $10.00 of lines and $1.00 tax, shared by price.
    const result = split(row(1100), totalLink(1100));
    expect(result).toMatchObject({ kind: 'split', cardTransactionId: 'synthetic-fresh-row', currency: 'USD', evidenceClass: 'unique-total-match' });
    expect(parts(result)).toEqual([[line(0, 0).ref, 660, GROCERIES, 'item-taxonomy', 'policy-allocated'],
      [line(1, 0).ref, 330, PHARMACY, 'item-taxonomy', 'policy-allocated'],
      [line(2, 0).ref, 110, GROCERIES, 'fresh-default', 'policy-allocated']]);
  });
  it('splits a tipped order\'s order part (the total less its tip) and an Amazon payments-ledger Charged row alike', () => {
    expect(parts(split(row(1000), orderPart(1000), order({ tip: 300 })))).toEqual([[line(0, 0).ref, 600, GROCERIES, 'item-taxonomy', 'policy-allocated'],
      [line(1, 0).ref, 300, PHARMACY, 'item-taxonomy', 'policy-allocated'], [line(2, 0).ref, 100, GROCERIES, 'fresh-default', 'policy-allocated']]);
    const ledger = split(row(550), ledgerLink(550));
    expect(ledger?.evidenceClass).toBe('payment-ledger-complete');
    expect(parts(ledger)!.map(p => p[1])).toEqual([330, 165, 55]);
  });
  it('keeps a line whose card category is not one of the household\'s in the rest of the charge, under the card\'s own category', () => {
    expect(parts(split(row(1100), totalLink(1100), order(), new Set([GROCERIES])))).toEqual([
      [line(0, 0).ref, 660, GROCERIES, 'item-taxonomy', 'policy-allocated'], [line(2, 0).ref, 110, GROCERIES, 'fresh-default', 'policy-allocated'],
      [null, 330, null, null, 'residual']]);
    // None at all: the charge stays as it was, whole.
    expect(split(row(1100), totalLink(1100), order(), new Set(['Synthetic Travel']))).toBeNull();
  });
  it('gives a line its cents by its stable line identity, never by the list\'s order, and skips a line that costs nothing', () => {
    const even = order({ lines: [line(0, 100), line(1, 100), line(2, 100), line(3, 0)] });
    const turned = order({ lines: [...even.lines].reverse() });
    const byRef = (o: FreshSplitOrder) => new Map(split(row(100), totalLink(100), o)!.contributions.map(p => [p.itemRef, p.amountMinor]));
    expect(byRef(even)).toEqual(byRef(turned));
    expect([...byRef(even).values()].sort()).toEqual([33, 33, 34]);
    expect(byRef(even).has(line(3, 0).ref)).toBe(false);
  });
  // Each keeps the charge's own resolution (null): the policy applies to nothing else.
  const guards: Array<[string, () => ReturnType<typeof split>]> = [
    ['a resolution split by the order\'s own items', () => split(row(1100), totalLink(1100), order(), household,
      { kind: 'split', cardTransactionId: 'synthetic-fresh-row', currency: 'USD', evidenceClass: 'unique-total-match', contributions: [] })],
    ['a resolution whole for another reason', () => split(row(1100), totalLink(1100), order(), household, whole('mixed-tender-unproven'))],
    ['a driver-tips charge', () => split(row(300, { description: 'AMAZON TIPS*SYNTH' }), ledgerLink(300), order({ tip: 300 }))],
    ['a ledger charge of exactly the order\'s tip', () => split(row(300), ledgerLink(300), order({ tip: 300 }))],
    ['a tipped order\'s whole total', () => split(row(1300), totalLink(1300), order({ tip: 300 }))],
    ['the deferred tip part', () => split(row(300), totalLink(300, { provenance: 'order-total-split',
      split: { part: 'tip', totalRef: opaque('order-total', ORDER_ID) } }))],
    ['an order total not proven single-card', () => split(row(1100), totalLink(1100, { tenderProof: 'unknown' }))],
    ['a ledger refund', () => split(row(1100), ledgerLink(1100, { provenance: 'ledger-Refunded' }))],
    ['a ledger charge not completed', () => split(row(1100), ledgerLink(1100, { status: 'pending' }))],
    ['a pending card row', () => split(row(1100, { status: 'pending' }), totalLink(1100))],
    ['a card refund', () => split(row(1100, { kind: 'refund' }), totalLink(1100))],
    ['a subject of another amount', () => split(row(1100), totalLink(1000))],
    ['a subject of two orders', () => split(row(1100), totalLink(1100, { orderRefs: [ORDER, opaque('order', 'synthetic-two')] }))],
    ['a subject with an item allocation', () => split(row(1100), totalLink(1100, { allocations: [{ itemRef: line(0, 0).ref, amountMinor: 1100,
      currency: 'USD', attribution: 'order-total-policy', sourceCategory: null }] }))],
    ['an order without a usable Item List', () => freshSplit(row(1100), totalLink(1100), whole(), new Map(), household)],
    ['a list in another currency', () => split(row(1100), totalLink(1100), order({ currency: 'CAD' }))],
    ['lines that all cost nothing', () => split(row(1100), totalLink(1100), order({ lines: [line(0, 0)] }))],
  ];
  it.each(guards)('never splits %s', (_, run) => expect(run()).toBeNull());
});

describe('Amazon Fresh split policy end to end: imported Item List, linked charge, resolver and card detail', () => {
  let dir: string, repo: SqliteStateRepo, backups = 0;
  const db = () => repo.internalGetDb();
  const backup = () => path.join(dir, `backup-${++backups}.db`);
  const chargeId = () => readLedger(db()).find(r => r.amountMinor === 1100)!.id;
  /** The synthetic order as a Fresh order (no order items) with its Item List: three lines that reconcile to its $10.00 item
   * subtotal, or ($9.50 of lines) that don't. */
  const freshCapture = (reconciles = true) => {
    const capture = syntheticCapture() as ReturnType<typeof syntheticCapture> & { fresh?: unknown };
    capture.staging.orders[0].items = [];
    capture.staging.orders[0].itemProof = { complete: false, unknownLine: true, conflict: false };
    capture.staging.coverage.details = { status: 'held', reason: 'budget', pages: 1, records: 0, rejected: 0 };
    const lines = [600, 300, reconciles ? 100 : 50].map((cents, lineOrdinal) => ({ lineOrdinal, title: `Synthetic fresh item ${lineOrdinal}`,
      asin: null, status: 'listed' as const, quantity: 1, weight: null, unitPrice: null, linePrice: usd(cents), replaces: null }));
    capture.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
      lists: [{ orderId: ORDER_ID, statedCount: 3, rows: 3, proof: { complete: true, unreadRows: 0 }, reconciled: reconciles, lines }],
      diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: 3, lines: 3, unread: [] }] };
    return capture;
  };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-fresh-split-synthetic-')); backups = 0;
    repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') });
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    // The household's Groceries card category is one its card rows already use.
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
        description: 'AMAZON.COM*SYNTH FRESH', issuerCategory: GROCERIES }] });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
  });
  afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('splits the linked charge over the list\'s lines, counts it itemized and shows the lines as its items', async () => {
    await importAmazonCapture(db(), freshCapture(), backup());
    expect([...readFreshSplitOrders(db()).keys()]).toEqual([ORDER]);
    const snapshot = createAmazonCategoryResolver(db()).snapshot(), id = chargeId();
    const resolution = snapshot.resolve(readLedger(db())).get(id);
    expect(resolution?.kind === 'split' && resolution.contributions.map(p => [p.amountMinor, p.category, p.categorySource, p.classification]))
      .toEqual([[660, GROCERIES, 'fresh-default', 'policy-allocated'], [330, GROCERIES, 'fresh-default', 'policy-allocated'],
        [110, GROCERIES, 'fresh-default', 'policy-allocated']]);
    expect(snapshot.matchCounts.itemizedRows).toBe(1);
    expect(snapshot.linkedChargeItemization(id)).toBe('itemized');
    const detail = snapshot.getCardDetail(id);
    expect(detail.items?.map(i => [i.title, i.quantity, i.asin])).toEqual([['Synthetic fresh item 0', 1, null],
      ['Synthetic fresh item 1', 1, null], ['Synthetic fresh item 2', 1, null]]);
    expect(detail.parts?.map(p => p.itemRef)).toEqual(detail.items?.map(i => i.itemRef));
  });
  it('keeps the charge whole while the Item List does not reconcile to the order\'s item subtotal', async () => {
    await importAmazonCapture(db(), freshCapture(false), backup());
    expect(readFreshSplitOrders(db()).size).toBe(0);
    const snapshot = createAmazonCategoryResolver(db()).snapshot();
    expect(snapshot.resolve(readLedger(db())).get(chargeId())).toEqual({ kind: 'whole-row', cardTransactionId: chargeId(),
      reason: 'item-identity-unproven' });
    expect(snapshot.matchCounts.itemizedRows).toBe(0);
  });
  it('names the policy and the lists a split used in the resolver version, and only while a split uses them', async () => {
    await importAmazonCapture(db(), freshCapture(), backup());
    const version = () => createAmazonCategoryResolver(db()).snapshot().version;
    const itemized = () => createAmazonCategoryResolver(db()).snapshot().matchCounts.itemizedRows;
    const withSplit = version();
    expect(itemized()).toBe(1);
    // The same facts without the order's active list (only the Fresh tables change): no split, so another version.
    db().prepare('CREATE TEMP TABLE kept AS SELECT * FROM amazon_fresh_orders').run();
    db().prepare('DELETE FROM amazon_fresh_orders').run();
    expect(itemized()).toBe(0);
    expect(version()).not.toBe(withSplit);
    db().prepare('INSERT INTO amazon_fresh_orders SELECT * FROM kept').run();
    expect(version()).toBe(withSplit);
    // A change to the used list alone (a line's title, which the card detail shows), the split still made: another version.
    db().prepare(`UPDATE amazon_fresh_lines SET data_json=json_set(data_json,'$.title','Synthetic fresh item renamed')
      WHERE line_ordinal=0`).run();
    expect(itemized()).toBe(1);
    expect(version()).not.toBe(withSplit);
  });
});
