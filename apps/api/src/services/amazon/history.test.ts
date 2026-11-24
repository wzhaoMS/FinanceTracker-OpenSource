import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, compareObservation, importAmazonCapture, projectRefunds, provesAtLeast, recordBindingProposal, recordRootApproval } from './importer.js';
import { orderObservationScope, validateCapture } from './capture.js';
import { orderHistoryConflicts } from './allocation.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { readLedger, readSubjects, reconcileAmazon } from './matcher.js';
import { digest, LEDGER_POLICY_DIGEST, opaque } from './policy.js';
import { rootApproval, syntheticCapture, syntheticEvidence, withRefundEvidence } from './fixtures.testSupport.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { amazonSpending } from './spending.js';
import { listRefundEvents } from './refundEvents.js';
import { productKey } from './products.js';
import { adoptionReview, applyCategoryAdoption, categoryKeyAdoptions, validateCategoryAdoption, type AdoptionCounts,
  type CategoryKeyAdoption } from './ownerDecisions.js';
import { cardSyncActorRef } from '../cardSyncDigests.js';
import type { OrderObservation, PaymentObservation, RefundEvidence } from './types.js';

function complete(run = 1, amounts: number[] = [600, 500]) {
  const capture = syntheticCapture(), order = capture.staging.orders[0];
  capture.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  order.itemProof = { complete: true, unknownLine: false, conflict: false };
  order.items[0].unitPrice!.amountMinor = 500;
  order.items.push({ ...structuredClone(order.items[0]), lineOrdinal: 1, title: 'Synthetic second widget' });
  capture.staging.coverage.details.records = 2;
  capture.staging.payments = amounts.map((amountMinor, ordinal): PaymentObservation => ({
    date: '2026-09-03', money: { currency: 'USD', amountMinor }, kind: 'charge', status: 'completed',
    method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [order.orderId], identity: 'native-row',
    provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal },
  }));
  capture.staging.coverage.payments = { status: amounts.length ? 'partial' : 'held', reason: 'budget', pages: 1,
    records: amounts.length, rejected: 0 };
  return capture;
}
function header(run = 2, amounts: number[] = [600, 500]) {
  const capture = complete(run, amounts), order = capture.staging.orders[0];
  order.items = []; order.paymentMethods = []; order.summary = []; order.tenderCoverage = 'unknown';
  delete order.itemProof;
  order.tenderProof = { methodComplete: false, summaryComplete: false,
    unknownMethod: false, unknownSummary: false, conflict: false };
  capture.staging.coverage.details = { status: 'held', reason: 'budget', pages: 0, records: 0, rejected: 0 };
  capture.structure = {
    format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown',
    code: 'complete', requests: 0, pages: [], stop: null,
    itemDiagnostics: { orders: [{ ordinal: 0, observed: false, quantities: { displayed: 0, inferred: 0 } }] },
    tenderDiagnostics: {
      orders: [{ ordinal: 0, reasons: ['method-incomplete', 'row-shape'], proof: {
        summary: { observed: false, enteredRowLoop: false, outsideRows: false,
          outside: { rows: 0, labels: 0, contents: 0, financialLists: 0, nonFinancialLists: 0 },
          nestedCandidate: false, relations: { ancestor: 0, sibling: 0, inside: 0 },
          initialComplete268: false, hold270: false, hold286: false, evaluated286: false, legacyOutsideRows: false },
        failed: ['method-complete', 'summary-complete'], conflicts: ['summary-hold', 'method-incomplete'],
      } }],
      counts: { 'unknown-label': 0, 'row-shape': 1, 'extra-text': 0, 'duplicate-kind': 0,
        arithmetic: 0, 'method-incomplete': 1, 'multi-tender': 0 },
      unknownLabels: [], unreportedUnknownLabelOrders: 0,
    },
  };
  return capture;
}
const originalStructure = () => syntheticCapture().structure;
/**
 * The pre-fix reader's read of a complete order (2026-11): it could not read the method block, so its tender proof
 * carries the reader's own conflict for that, and its item proof stays incomplete. `conflicts`: the capture's sources.
 */
function unreadTender(run = 1, conflicts: string[] = ['method-incomplete']) {
  const capture = complete(run), order = capture.staging.orders[0];
  order.paymentMethods = []; order.tenderCoverage = 'unknown';
  order.tenderProof = { methodComplete: false, summaryComplete: true, unknownMethod: true, unknownSummary: false, conflict: true };
  order.itemProof = { complete: false, unknownLine: false, conflict: false };
  const structure = header().structure as { tenderDiagnostics: { orders: Array<{ proof: { conflicts: string[] } }> } };
  structure.tenderDiagnostics.orders[0].proof.conflicts = conflicts;
  capture.structure = structure;
  return capture;
}
/** The reviewers' partial read: tender unknown, no completeness proof, an unknown line. */
function partial(run: number) {
  const capture = syntheticCapture(), order = capture.staging.orders[0];
  capture.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  order.tenderCoverage = 'unknown';
  order.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: true, conflict: false };
  order.itemProof = { complete: false, unknownLine: true, conflict: false };
  return capture;
}
const changedOrder = (order: OrderObservation, field: 'items' | 'methods' | 'summary' | 'total') => {
  if (field === 'items') order.items[0].title = 'Synthetic conflicting widget';
  if (field === 'methods') order.paymentMethods![0].last4 = '9002';
  if (field === 'summary') {
    order.summary!.find(s => s.kind === 'shipping')!.money.amountMinor = 50;
    order.summary!.find(s => s.kind === 'tax')!.money.amountMinor = 50;
  }
  if (field === 'total') {
    order.total!.amountMinor = 1200;
    order.summary!.find(s => s.kind === 'tax')!.money.amountMinor = 200;
    order.summary!.find(s => s.kind === 'grand-total')!.money.amountMinor = 1200;
  }
};

describe('closed header-only observation witness', () => {
  it('validates the original full envelope before deriving an ordinal-scoped marker', async () => {
    const capture = header();
    const validated = await validateCapture(capture);
    expect(orderObservationScope(validated.structure, validated.staging.orders[0], 0)).toBe('header-only');
    expect(orderObservationScope(validated.structure, validated.staging.orders[0], 1)).toBe('legacy');
    expect(orderObservationScope(originalStructure(), validated.staging.orders[0], 0)).toBe('legacy');
  });
  it.each(['items', 'methods', 'summary', 'tenderCoverage', 'itemProof', 'tenderProof', 'refundSummary'] as const)(
    'never classifies a positive or conflicting %s as a header', field => {
      const capture = header(), order = capture.staging.orders[0], proven = complete().staging.orders[0];
      if (field === 'items') order.items = proven.items;
      if (field === 'methods') order.paymentMethods = proven.paymentMethods;
      if (field === 'summary') order.summary = proven.summary;
      if (field === 'tenderCoverage') order.tenderCoverage = 'multi-tender';
      if (field === 'itemProof') order.itemProof = { complete: false, unknownLine: true, conflict: false };
      if (field === 'tenderProof') order.tenderProof!.conflict = true;
      if (field === 'refundSummary') order.refundSummary = { currency: 'USD', amountMinor: 100 };
      // Order-history v4: a conflict whose sources (here summary-hold and method-incomplete) are all unread tender is
      // no header, and no contradiction either.
      expect(orderObservationScope(capture.structure, order, 0)).toBe(field === 'tenderProof' ? 'tender-unread' : 'legacy');
    });
  it('keeps missing, observed, gated, or conflicting diagnostics conservative', () => {
    const capture = header(), order = capture.staging.orders[0];
    const report = capture.structure as {
      itemDiagnostics: { orders: Array<{ observed: boolean }> };
      tenderDiagnostics: { orders: Array<{ gates?: unknown; proof?: { summary: { observed: boolean }; conflicts: string[] } }> };
    };
    report.itemDiagnostics.orders[0].observed = true;
    expect(orderObservationScope(report, order, 0)).toBe('legacy');
    report.itemDiagnostics.orders[0].observed = false;
    const tender = report.tenderDiagnostics.orders[0];
    tender.gates = { status: 'gate-budget-held' };
    expect(orderObservationScope(report, order, 0)).toBe('legacy');
    delete tender.gates;
    tender.proof!.summary.observed = true;
    expect(orderObservationScope(report, order, 0)).toBe('legacy');
    tender.proof!.summary.observed = false;
    tender.proof!.conflicts = ['detail-conflict'];
    expect(orderObservationScope(report, order, 0)).toBe('legacy');
    delete tender.proof;
    expect(orderObservationScope(report, order, 0)).toBe('legacy');
  });
});

let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const snapshot = () => createAmazonCategoryResolver(db()).snapshot();
const resolutions = () => [...snapshot().resolve(readLedger(db())).values()];
const matches = () => db().prepare(`SELECT * FROM amazon_matches UNION ALL SELECT * FROM amazon_ledger_matches
  ORDER BY subject_ref`).all();
const stored = () => db().prepare('SELECT * FROM amazon_observations ORDER BY ref').all();
const auditCount = () => db().prepare('SELECT count(*) FROM amazon_audit').pluck().get();
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-history-synthetic-')); backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: [600, 500].map((amountMinor, ordinal) => ({ transactionDate: '2026-09-03', status: 'posted',
      kind: 'purchase', currency: 'USD', amountMinor, description: `AMAZON SYNTHETIC ${ordinal}`, issuerCategory: 'Shopping' })) });
  const cards = readCardInventory(db()), proposal = proposeBindings([{
    network: 'visa', last4: '9001', cardAccountId: card.id,
  }], cards);
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('synthetic header history, anchored allocation and re-registration', () => {
  it('never lets a later header-only observation displace an order already stored with details', async () => {
    const detailed = complete();
    detailed.staging.orders[0].refundSummary = { currency: 'USD', amountMinor: 500 };
    await importAmazonCapture(db(), detailed, backup());
    const orderRow = () => db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get();
    const subjectRow = () => db().prepare("SELECT data_json FROM amazon_subjects WHERE evidence_class='unique-total-match'").pluck().get();
    const before = { order: orderRow(), subject: subjectRow(), matches: matches(), resolutions: resolutions() };
    const reread = header(3, []);
    await importAmazonCapture(db(), reread, backup());
    expect(orderRow()).toEqual(before.order);
    expect(subjectRow()).toBe(before.subject);
    expect(matches()).toEqual(before.matches);
    expect(resolutions()).toEqual(before.resolutions);
    const order = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
    expect(order.items).toHaveLength(2);
    expect(order.refundSummary).toEqual({ currency: 'USD', amountMinor: 500 });
    // The header-only observation is still retained as history, and the kept decision is audited.
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE hold_reason='header-only-observation'").pluck().get()).toBe(1);
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='header-only-kept-details'").pluck().get()).toBe(1);
    // A later detailed superset still replaces the stored one; a smaller Refund Total is a conflict, history only (a larger
    // one is a refund progression: see 'refund progressions').
    const later = complete(4);
    later.staging.orders[0].refundSummary = { currency: 'USD', amountMinor: 500 };
    await importAmazonCapture(db(), later, backup());
    const replaced = orderRow();
    expect(replaced).not.toEqual(before.order);
    const changed = complete(5);
    changed.staging.orders[0].refundSummary = { currency: 'USD', amountMinor: 300 };
    await importAmazonCapture(db(), changed, backup());
    expect(orderRow()).toEqual(replaced);
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.refundSummary).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='conflicting-observation-kept-details'").pluck().get()).toBe(1);
  });
  it('still stores a header-only observation for an order seen with no details yet', async () => {
    await importAmazonCapture(db(), header(), backup());
    expect(listAmazonOrders(db(), 0, 1).orders[0].itemObservations).toBe(0);
    await importAmazonCapture(db(), complete(), backup());
    expect(listAmazonOrders(db(), 0, 1).orders[0].itemObservations).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='header-only-kept-details'").pluck().get()).toBe(0);
  });
  // Under order-history policy v3 a field a read does not prove is never compared, and each poorer read below proves no
  // field that differs from the displayed one: none holds the kept subject's or the anchored card rows' allocation.
  const partials: Array<[string, (o: OrderObservation) => void]> = [
    ['a method-only page', o => { o.items = []; o.summary = []; o.tenderCoverage = 'unknown';
      o.itemProof = { complete: false, unknownLine: true, conflict: false };
      o.tenderProof = { methodComplete: true, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false }; }],
    ['a title-only line', o => { o.items = [{ ...o.items[0], quantity: null, unitPrice: null }]; o.summary = []; o.paymentMethods = [];
      o.tenderCoverage = 'unknown'; o.itemProof = { complete: false, unknownLine: true, conflict: false };
      o.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false }; }],
    ['a missing line price', o => { o.items[1].unitPrice = null; o.itemProof = { complete: false, unknownLine: true, conflict: false }; }],
    ['a missing Refund Total', () => undefined],
    ['an empty charge-free page', o => { o.items = []; o.summary = []; o.paymentMethods = []; o.tenderCoverage = 'unknown';
      delete o.itemProof;
      o.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false }; }],
  ];
  it.each(partials)('keeps the displayed order, its lines, Refund Total, spending and allocation over %s', async (_, degrade) => {
    const rich = complete();
    rich.staging.orders[0].refundSummary = { currency: 'USD', amountMinor: 500 };
    await importAmazonCapture(db(), rich, backup());
    const orderRow = () => db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get();
    const subject = () => JSON.parse(db().prepare("SELECT data_json FROM amazon_subjects WHERE evidence_class='unique-total-match'")
      .pluck().get() as string) as Record<string, unknown>;
    const view = () => amazonSpending(db(), '2Y', '2026-10-19');
    const split = () => resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete');
    const before = { order: orderRow(), subject: subject(), view: view() };
    expect(before.subject.allocationComplete).toBe(true);
    expect(split()).toBe(true);
    const poorer = complete(3, []);
    degrade(poorer.staging.orders[0]);
    const lines = poorer.staging.orders[0].items.length;
    poorer.staging.coverage.details = lines ? { ...poorer.staging.coverage.details, records: lines }
      : { status: 'held', reason: 'selector-failed', pages: 1, records: 0, rejected: 0 };
    await importAmazonCapture(db(), poorer, backup());
    expect(orderRow()).toEqual(before.order);
    expect(view().totals).toEqual(before.view.totals);
    expect(subject()).toEqual(before.subject);
    // The order's matched card rows stay itemized.
    expect(split()).toBe(true);
    const order = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
    expect(order.items.map(i => i.unitPrice)).toEqual([{ currency: 'USD', amountMinor: 500 }, { currency: 'USD', amountMinor: 500 }]);
    expect(order.refundSummary).toEqual({ currency: 'USD', amountMinor: 500 });
    // The poorer read is history only, and the kept decision is audited.
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE family='order'").pluck().get()).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='poorer-observation-kept-details'").pluck().get()).toBe(1);
  });
  it.each([true, false])('keeps a priced order without item proof over a charge-free header (witnessed=%s)', async witnessed => {
    const rich = syntheticCapture(), o = rich.staging.orders[0];
    o.items = [{ lineOrdinal: 0, itemId: 'SYNTH00002', title: 'Synthetic review kettle', quantity: 2,
      unitPrice: { currency: 'USD', amountMinor: 550 } }];
    o.summary = [{ kind: 'items-subtotal', money: { currency: 'USD', amountMinor: 1100 } },
      { kind: 'shipping', money: { currency: 'USD', amountMinor: 0 } }, { kind: 'tax', money: { currency: 'USD', amountMinor: 0 } },
      { kind: 'grand-total', money: { currency: 'USD', amountMinor: 1100 } }];
    await importAmazonCapture(db(), rich, backup());
    const view = () => amazonSpending(db(), '2Y', '2026-10-19');
    const before = { order: db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get(), view: view() };
    expect(before.view.totals[0].itemMinor).toBe(1100);
    const empty = header(3, []);
    if (!witnessed) empty.structure = originalStructure();
    await importAmazonCapture(db(), empty, backup());
    expect(db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get()).toEqual(before.order);
    expect(view().totals).toEqual(before.view.totals);
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.items).toHaveLength(1);
  });
  // Root's per-fact superset rule: each later read is valid and imports, but only a superset may replace the display.
  const supersets: Array<[string, (o: OrderObservation) => void, (o: OrderObservation) => void, 'poorer' | 'conflict']> = [
    ['four summary components to one', () => undefined, o => { o.summary = o.summary!.filter(s => s.kind === 'grand-total'); }, 'poorer'],
    ['two instruments to one', o => { o.paymentMethods!.push({ kind: 'balance', network: 'unknown', last4: null }); },
      o => { o.paymentMethods!.pop(); }, 'poorer'],
    ['a known ASIN to none', () => undefined, o => { o.items[0].itemId = null; }, 'poorer'],
    ['a header total to none', o => { o.summary = []; }, o => { o.total = null; }, 'poorer'],
    ['a price moved to another line at an equal count', o => {
      o.items.push({ ...structuredClone(o.items[0]), lineOrdinal: 1, itemId: 'SYNTH00002', title: 'Synthetic second item', unitPrice: null });
    }, o => { o.items[1].unitPrice = o.items[0].unitPrice; o.items[0].unitPrice = null; }, 'poorer'],
    ['a different line price', () => undefined, o => { o.items[0].unitPrice = { currency: 'USD', amountMinor: 900 }; }, 'conflict'],
    ['a different header total', o => { o.summary = []; }, o => { o.total = { currency: 'USD', amountMinor: 1200 }; }, 'conflict'],
  ];
  it.each(supersets)('keeps the displayed order over %s', async (_, setup, change, relation) => {
    const shown = partial(11);
    setup(shown.staging.orders[0]);
    shown.staging.coverage.details.records = shown.staging.orders[0].items.length;
    const next = structuredClone(shown);
    next.staging.runId = '00000000-0000-4000-8000-000000000012';
    change(next.staging.orders[0]);
    expect(compareObservation(next.staging.orders[0], shown.staging.orders[0])).toBe(relation);
    expect(provesAtLeast(next.staging.orders[0], shown.staging.orders[0])).toBe(false);
    await importAmazonCapture(db(), shown, backup());
    const orderRow = () => db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get();
    const before = orderRow();
    await importAmazonCapture(db(), next, backup());
    expect(orderRow()).toEqual(before);
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE family='order'").pluck().get()).toBe(2);
    expect(db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck()
      .get(`${relation === 'conflict' ? 'conflicting' : 'poorer'}-observation-kept-details`)).toBe(1);
  });
  it('replaces the displayed order with a true per-fact superset', async () => {
    const shown = partial(11), o = shown.staging.orders[0];
    o.summary = o.summary!.filter(s => s.kind === 'grand-total');
    o.items[0].unitPrice = null;
    const next = structuredClone(shown), n = next.staging.orders[0];
    next.staging.runId = '00000000-0000-4000-8000-000000000012';
    n.summary = structuredClone(syntheticCapture().staging.orders[0].summary);
    n.paymentMethods!.push({ kind: 'balance', network: 'unknown', last4: null });
    n.items[0].unitPrice = { currency: 'USD', amountMinor: 1000 };
    n.items.push({ lineOrdinal: 1, itemId: 'SYNTH00002', title: 'Synthetic second item', quantity: 1, unitPrice: null });
    n.refundSummary = { currency: 'USD', amountMinor: 100 };
    next.staging.coverage.details.records = 2;
    expect(compareObservation(n, o)).toBe('superset');
    await importAmazonCapture(db(), shown, backup());
    const latest = () => db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get();
    const before = latest();
    await importAmazonCapture(db(), next, backup());
    expect(latest()).not.toBe(before);
    const order = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
    expect(order.items).toHaveLength(2);
    expect(order.refundSummary).toEqual({ currency: 'USD', amountMinor: 100 });
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action LIKE '%-kept-details'").pluck().get()).toBe(0);
  });
  it('lets an equal or richer re-read replace the displayed order', async () => {
    await importAmazonCapture(db(), complete(), backup());
    const latest = () => db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get();
    const first = latest();
    await importAmazonCapture(db(), complete(3), backup());
    const second = latest();
    expect(second).not.toBe(first);
    const richer = complete(4);
    richer.staging.orders[0].refundSummary = { currency: 'USD', amountMinor: 500 };
    await importAmazonCapture(db(), richer, backup());
    expect(latest()).not.toBe(second);
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.refundSummary).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action LIKE '%-kept-details'").pluck().get()).toBe(0);
  });
  it.each([false, true])('allocates header/complete observations in either import order (header first=%s)', async headerFirst => {
    const before = JSON.stringify(readLedger(db()));
    for (const capture of headerFirst ? [header(), complete()] : [complete(), header()]) {
      await importAmazonCapture(db(), capture, backup());
    }
    expect(resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete')).toBe(true);
    expect(resolutions().flatMap(r => r.kind === 'split' ? r.contributions : [])
      .reduce((sum, p) => sum + p.amountMinor, 0)).toBe(1100);
    expect(readSubjects(db()).filter(s => s.evidenceClass === 'payment-ledger-complete')).toHaveLength(4);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'").pluck().get()).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE json_extract(data_json,'$.reason')='corroborated'")
      .pluck().get()).toBe(2);
    expect(snapshot().getCardDetail(readLedger(db())[0].id).items).toHaveLength(2);
    expect(JSON.stringify(readLedger(db()))).toBe(before);
  });
  it.each(['items', 'methods', 'summary', 'total'] as const)('holds complete/complete %s differences, including after a later header', async field => {
    await importAmazonCapture(db(), complete(), backup());
    const changed = complete(3); changedOrder(changed.staging.orders[0], field);
    await importAmazonCapture(db(), changed, backup());
    await importAmazonCapture(db(), header(), backup());
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
  });
  it.each([['items', false], ['methods', true], ['summary', true], ['total', true]] as const)(
    'compares a partial read\'s %s only where it proves them (held=%s)', async (field, held) => {
      await importAmazonCapture(db(), complete(), backup());
      const partial = complete(3); changedOrder(partial.staging.orders[0], field);
      partial.staging.orders[0].itemProof!.complete = false;
      partial.staging.orders[0].itemProof!.unknownLine = true;
      await importAmazonCapture(db(), partial, backup());
      // Its item set is unproven, so its changed title is never compared; its complete methods, summary and total are.
      expect(resolutions().every(r => (held ? r.kind === 'whole-row' && r.reason === 'inconsistent-evidence'
        : r.kind === 'split'))).toBe(true);
    });
  it('never infers a header marker from legacy empty rows or missing diagnostics, and needs none to allocate', async () => {
    const legacy = header(); legacy.structure = originalStructure();
    await importAmazonCapture(db(), legacy, backup());
    await importAmazonCapture(db(), complete(), backup());
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE hold_reason='header-only-observation'").pluck().get()).toBe(0);
    // The unmarked empty read proves only its total, which agrees: nothing is held.
    expect(resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete')).toBe(true);
  });
  it('keeps never-complete and unfinalized details item-identity-unproven rather than fabricating proof', async () => {
    await importAmazonCapture(db(), header(), backup());
    const partial = complete();
    partial.staging.orders[0].itemProof = { complete: false, unknownLine: true, conflict: false };
    partial.staging.orders[0].items[0].quantity = null;
    await importAmazonCapture(db(), partial, backup());
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'item-identity-unproven')).toBe(true);
  });
  it('keeps an observed header total difference held and explicit conflicts held, marker or not', () => {
    const a = header().staging.orders[0], b = complete().staging.orders[0];
    a.total!.amountMinor++;
    expect(orderHistoryConflicts([{ order: a }, { order: b }])).toBe(true);
    a.total!.amountMinor--; a.tenderProof!.conflict = true;
    expect(orderHistoryConflicts([{ order: a }])).toBe(true);
  });
  it('registers existing captures once without changing baseline anchor-policy metadata, then repeats with zero change', async () => {
    const h = header(), c = complete();
    await importAmazonCapture(db(), h, backup()); await importAmazonCapture(db(), c, backup());
    // Reproduce the pre-fix importer: it retained staging but not the full-envelope header witness.
    db().prepare("UPDATE amazon_observations SET hold_reason='payment-coverage-held' WHERE family='order'").run();
    const oldSubjects = db().prepare('SELECT ref,data_json FROM amazon_subjects').all() as Array<{ ref: string; data_json: string }>;
    for (const row of oldSubjects) {
      const subject = JSON.parse(row.data_json);
      subject.allocations = []; subject.allocationComplete = false; subject.allocationHoldReason = 'inconsistent-evidence';
      db().prepare('UPDATE amazon_subjects SET data_json=? WHERE ref=?').run(JSON.stringify(subject), row.ref);
    }
    const baselineLedgerPolicyDigest = '921533072b7f537bdafbc182ff6f12baaed3ba2a8ff1d5cd882a9ff546c8b377';
    expect(LEDGER_POLICY_DIGEST).toBe(baselineLedgerPolicyDigest);
    const baselineMatches = db().prepare('SELECT subject_ref,data_json FROM amazon_ledger_matches').all() as
      Array<{ subject_ref: string; data_json: string }>;
    for (const row of baselineMatches) {
      const match = JSON.parse(row.data_json);
      match.policyDigest = baselineLedgerPolicyDigest;
      db().prepare('UPDATE amazon_ledger_matches SET data_json=? WHERE subject_ref=?').run(JSON.stringify(match), row.subject_ref);
    }
    // Order-history policy v3 needs no marker: the unmarked empty header proves only its agreeing total, so the derived
    // allocation is back before re-registration, which still records only the marker.
    expect(resolutions().every(r => r.kind === 'split')).toBe(true);
    const oldMatches = matches(), oldLedger = JSON.stringify(readLedger(db())), oldRows = stored();
    const oldCaptures = db().prepare('SELECT * FROM amazon_captures ORDER BY digest').all();
    const oldRuns = db().prepare('SELECT * FROM amazon_capture_runs ORDER BY capture_digest').all();
    const oldOrders = db().prepare('SELECT * FROM amazon_orders ORDER BY ref').all();
    const beforeAudit = Number(auditCount());
    for (const capture of [h, c]) expect(await importAmazonCapture(db(), capture, backup())).toMatchObject({
      newCaptures: 0, newOrders: 0, newObservations: 0, newMatches: 0, invalidated: 0,
    });
    expect(resolutions().every(r => r.kind === 'split')).toBe(true);
    expect(matches()).toEqual(oldMatches);
    expect(JSON.stringify(readLedger(db()))).toBe(oldLedger);
    expect(db().prepare('SELECT * FROM amazon_captures ORDER BY digest').all()).toEqual(oldCaptures);
    expect(db().prepare('SELECT * FROM amazon_capture_runs ORDER BY capture_digest').all()).toEqual(oldRuns);
    expect(db().prepare('SELECT * FROM amazon_orders ORDER BY ref').all()).toEqual(oldOrders);
    const newRows = stored() as Array<{ hold_reason: string }>;
    expect(newRows.filter(o => o.hold_reason === 'header-only-observation')).toHaveLength(1);
    expect(newRows.map(o => ({ ...o, hold_reason: 'unchanged-for-comparison' })))
      .toEqual((oldRows as object[]).map(o => ({ ...o, hold_reason: 'unchanged-for-comparison' })));
    expect(Number(auditCount())).toBe(beforeAudit + 1);
    const after = JSON.stringify({ rows: stored(), matches: matches(), audit: auditCount(), subjects: readSubjects(db()) });
    for (const capture of [h, c]) await importAmazonCapture(db(), capture, backup());
    expect(JSON.stringify({ rows: stored(), matches: matches(), audit: auditCount(), subjects: readSubjects(db()) })).toBe(after);
  });
  it('does not collapse duplicate occurrences in a run when a header marker is added', async () => {
    const c = complete(1, [600, 500, 600]);
    await importAmazonCapture(db(), c, backup()); await importAmazonCapture(db(), header(), backup());
    expect(resolutions().every(r => r.kind === 'whole-row')).toBe(true);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'").pluck().get()).toBe(1);
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE family='payment'").pluck().get()).toBe(5);
  });
  it('derives fallback allocations on read, and re-registers without promoting or rewriting the stored card anchor', async () => {
    const card = readCardInventory(db())[0];
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD',
        amountMinor: 1100, description: 'AMAZON SYNTHETIC TOTAL', issuerCategory: 'Shopping' }] });
    const h = header(2, []), c = complete(1, []);
    await importAmazonCapture(db(), h, backup()); await importAmazonCapture(db(), c, backup());
    db().prepare("UPDATE amazon_observations SET hold_reason='payment-coverage-held' WHERE family='order'").run();
    const row = db().prepare('SELECT ref,data_json FROM amazon_subjects').get() as { ref: string; data_json: string };
    const subject = JSON.parse(row.data_json);
    subject.allocations = []; subject.allocationComplete = false; subject.allocationHoldReason = 'inconsistent-evidence';
    db().prepare('UPDATE amazon_subjects SET data_json=? WHERE ref=?').run(JSON.stringify(subject), row.ref);
    const cardRow = readLedger(db()).find(r => r.amountMinor === 1100)!;
    // Order-history policy v3: the unmarked empty header proves only its agreeing total, so whatever the stored subject
    // says, its allocation is derived back on read; re-registration only records the marker.
    expect(snapshot().resolve([cardRow]).get(cardRow.id)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    const anchor = matches(), before = db().prepare('SELECT * FROM amazon_subjects').all();
    await importAmazonCapture(db(), h, backup());
    expect(snapshot().resolve([cardRow]).get(cardRow.id)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    expect(matches()).toEqual(anchor);
    expect(db().prepare('SELECT * FROM amazon_subjects').all()).toEqual(before);
    const proof = { ...subject, provenance: 'unproven', tenderProof: 'unknown' };
    db().prepare('UPDATE amazon_subjects SET data_json=? WHERE ref=?').run(JSON.stringify(proof), row.ref);
    expect(readSubjects(db()).find(s => s.ref === row.ref)).toEqual(proof);
  });
});

describe('order-history policy v4: a tender conflict that is only unread tender (Root, 2026-11-22)', () => {
  const unread = "SELECT count(*) FROM amazon_observations WHERE hold_reason='tender-unread-observation'";
  it('scopes it from the validated capture\'s own sources, and only when every source is unread tender', async () => {
    for (const sources of [['method-incomplete'], ['summary-hold', 'method-incomplete'],
      ['unknown-label', 'summary-hold', 'method-incomplete']]) {
      const validated = await validateCapture(unreadTender(1, sources));
      expect(orderObservationScope(validated.structure, validated.staging.orders[0], 0)).toBe('tender-unread');
    }
    for (const other of ['record-limit', 'snapshot-mismatch', 'detail-conflict', 'summary-conflict', 'order-conflict']) {
      const validated = await validateCapture(unreadTender(1, ['method-incomplete', other]));
      expect(orderObservationScope(validated.structure, validated.staging.orders[0], 0)).toBe('legacy');
    }
    const none = unreadTender(1, []), order = none.staging.orders[0];
    expect(orderObservationScope(none.structure, order, 0)).toBe('legacy');
    const report = unreadTender().structure as { tenderDiagnostics: { orders: Array<{ proof?: unknown }> } };
    expect(orderObservationScope(report, order, 1)).toBe('legacy');
    delete report.tenderDiagnostics.orders[0].proof;
    expect(orderObservationScope(report, order, 0)).toBe('legacy');
    const quiet = unreadTender();
    quiet.staging.orders[0].tenderProof!.conflict = false;
    expect(orderObservationScope(quiet.structure, quiet.staging.orders[0], 0)).toBe('legacy');
  });
  it('holds nothing, while an item conflict or any other explicit tender conflict still holds', () => {
    const a = unreadTender().staging.orders[0], b = complete().staging.orders[0];
    expect(orderHistoryConflicts([{ order: a, scope: 'tender-unread' }, { order: b }])).toBe(false);
    expect(orderHistoryConflicts([{ order: a, scope: 'legacy' }, { order: b }])).toBe(true);
    expect(orderHistoryConflicts([{ order: a }, { order: b }])).toBe(true);
    a.itemProof!.conflict = true;
    expect(orderHistoryConflicts([{ order: a, scope: 'tender-unread' }, { order: b }])).toBe(true);
    // Its proven facts are still compared: here its total.
    const c = unreadTender().staging.orders[0];
    c.total!.amountMinor++;
    expect(orderHistoryConflicts([{ order: c, scope: 'tender-unread' }, { order: b }])).toBe(true);
  });
  it('lets a later complete read allocate the order past it', async () => {
    await importAmazonCapture(db(), unreadTender(), backup());
    expect(db().prepare(unread).pluck().get()).toBe(1);
    await importAmazonCapture(db(), complete(2), backup());
    expect(resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete')).toBe(true);
  });
  it('keeps holding a tender conflict with any other source', async () => {
    await importAmazonCapture(db(), unreadTender(1, ['method-incomplete', 'snapshot-mismatch']), backup());
    expect(db().prepare(unread).pluck().get()).toBe(0);
    await importAmazonCapture(db(), complete(2), backup());
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
  });
  it('re-scopes an observation the pre-fix importer stored, on its capture\'s exact repeat, once', async () => {
    const old = unreadTender();
    await importAmazonCapture(db(), old, backup());
    // Reproduce the pre-fix importer, which stored every such observation unmarked.
    db().prepare("UPDATE amazon_observations SET hold_reason='payment-coverage-held' WHERE hold_reason='tender-unread-observation'").run();
    await importAmazonCapture(db(), complete(2), backup());
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
    expect(await importAmazonCapture(db(), old, backup())).toMatchObject({ newCaptures: 0, newOrders: 0, newObservations: 0 });
    expect(db().prepare(unread).pluck().get()).toBe(1);
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='order-observation-scope'").pluck().get()).toBe(1);
    expect(resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete')).toBe(true);
    const after = JSON.stringify({ rows: stored(), matches: matches(), audit: auditCount(), subjects: readSubjects(db()) });
    await importAmazonCapture(db(), old, backup());
    expect(JSON.stringify({ rows: stored(), matches: matches(), audit: auditCount(), subjects: readSubjects(db()) })).toBe(after);
  });
});

describe('a summary proven complete replaces a displayed one never proven complete (Root, 2026-11-22)', () => {
  const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
  const cardRow = () => readLedger(db()).find(r => r.amountMinor === 1100)!;
  const resolution = () => snapshot().resolve([cardRow()]).get(cardRow().id);
  const latest = () => db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get();
  const kept = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action);
  // The 2026-11 shape: the displayed read missed one discount row (its label then unknown), so its summary never proved
  // complete and its promotion is the shown discount alone; a later read proves the whole summary, with the larger
  // promotion. Same header total, date, method and lines; only the later read's subject can link the card charge. An
  // unproven summary proves neither the tender nor the item block, as the reader stages it.
  const read = (run: number, promotion: number, proven: boolean, change: (o: OrderObservation) => void = () => undefined) => {
    const capture = complete(run, []), o = capture.staging.orders[0];
    o.summary = [{ kind: 'items-subtotal', money: usd(1000) }, { kind: 'shipping', money: usd(150) }, { kind: 'tax', money: usd(100) },
      { kind: 'promotion', money: usd(promotion) }, { kind: 'grand-total', money: usd(1100) }];
    o.tenderProof = { methodComplete: true, summaryComplete: proven, unknownMethod: false, unknownSummary: !proven, conflict: false };
    o.tenderCoverage = proven ? 'single-card-proven' : 'unknown';
    o.itemProof = { complete: proven, unknownLine: false, conflict: false };
    change(o);
    return capture;
  };
  beforeEach(() => {
    repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
        description: 'AMAZON SYNTHETIC SUMMARY', issuerCategory: 'Shopping' }] });
  });
  it('replaces the display, so the order-total subject proves the card charge and itemizes it', async () => {
    const shown = read(1, 100, false), next = read(3, 150, true);
    expect(compareObservation(next.staging.orders[0], shown.staging.orders[0])).toBe('superset');
    await importAmazonCapture(db(), shown, backup());
    expect(resolution()?.kind).not.toBe('split');
    const before = latest();
    await importAmazonCapture(db(), next, backup());
    expect(latest()).not.toBe(before);
    expect(kept('conflicting-observation-kept-details')).toBe(0);
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.summary)
      .toContainEqual({ kind: 'promotion', money: usd(150) });
    expect(resolution()).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
  });
  it('drops a displayed component the proven summary does not show, but still compares the displayed grand total', () => {
    const extra = read(1, 100, false, o => { o.summary!.push({ kind: 'rewards', money: usd(-50) }); });
    expect(compareObservation(read(3, 150, true).staging.orders[0], extra.staging.orders[0])).toBe('superset');
    const otherTotal = read(1, 100, false, o => { o.summary!.find(s => s.kind === 'grand-total')!.money = usd(1150); });
    expect(compareObservation(read(3, 150, true).staging.orders[0], otherTotal.staging.orders[0])).toBe('conflict');
  });
  // Controls: everything but the unproven summary's components still compares, and a proven displayed summary still must be
  // repeated. Each differing value is a conflict that keeps the display, and the card charge is not itemized.
  const controls: Array<[string, () => [ReturnType<typeof read>, ReturnType<typeof read>]]> = [
    ['a different header total', () => [read(1, 100, false), read(3, 150, true, o => {
      o.total = usd(1150); o.summary!.find(s => s.kind === 'tax')!.money = usd(150);
      o.summary!.find(s => s.kind === 'grand-total')!.money = usd(1150); })]],
    ['a different line price', () => [read(1, 100, false), read(3, 150, true, o => {
      o.items[0].unitPrice = usd(450); o.items[1].unitPrice = usd(550); })]],
    ['a different date', () => [read(1, 100, false), read(3, 150, true, o => { o.date = '2026-09-02'; })]],
    ['a different card', () => [read(1, 100, false), read(3, 150, true, o => { o.paymentMethods![0].last4 = '9002'; })]],
    ['a displayed summary that was proven complete', () => [read(1, 150, true),
      read(3, 100, true, o => { o.summary!.find(s => s.kind === 'shipping')!.money = usd(100); })]],
    ['a later summary that is not proven complete either', () => [read(1, 100, false), read(3, 150, false)]],
  ];
  it.each(controls)('still keeps the display over %s', async (_, reads) => {
    const [shown, next] = reads();
    expect(compareObservation(next.staging.orders[0], shown.staging.orders[0])).toBe('conflict');
    await importAmazonCapture(db(), shown, backup());
    const before = latest();
    await importAmazonCapture(db(), next, backup());
    expect(latest()).toBe(before);
    expect(kept('conflicting-observation-kept-details')).toBe(1);
    expect(resolution()?.kind).not.toBe('split');
  });
});

describe('line order is not a fact (Root, 2026-11-23)', () => {
  const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
  const cardRow = () => readLedger(db()).find(r => r.amountMinor === 1100)!;
  const resolution = () => snapshot().resolve([cardRow()]).get(cardRow().id);
  const latest = () => db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get();
  const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action);
  const shownOrder = () => getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
  type Line = [string | null, string, number];
  const LINES: Line[] = [['SYNTH00001', 'Synthetic blue widget', 300], ['SYNTH00002', 'Synthetic second widget', 200],
    ['SYNTH00003', 'Synthetic third widget', 250], ['SYNTH00004', 'Synthetic fourth widget', 250],
    ['SYNTH00005', 'Synthetic fifth widget', 0]];
  // #8's 2026-11 shape: four lines first read without quantities, an item proof or a proven summary; a later read proves all
  // three and lists the third and fourth lines the other way round, with the same ASINs, titles and prices.
  const read = (run: number, proven: boolean, order = [0, 1, 2, 3], change: (o: OrderObservation) => void = () => undefined,
    lines = LINES) => {
    const capture = complete(run, []), o = capture.staging.orders[0];
    o.items = order.map((n, lineOrdinal) => ({ lineOrdinal, itemId: lines[n][0], title: lines[n][1], quantity: proven ? 1 : null,
      unitPrice: usd(lines[n][2]) }));
    capture.staging.coverage.details.records = o.items.length;
    o.summary = [{ kind: 'items-subtotal', money: usd(1000) }, { kind: 'shipping', money: usd(150) }, { kind: 'tax', money: usd(100) },
      { kind: 'promotion', money: usd(150) }, { kind: 'grand-total', money: usd(1100) }];
    o.tenderProof = { methodComplete: true, summaryComplete: proven, unknownMethod: false, unknownSummary: !proven, conflict: false };
    o.tenderCoverage = proven ? 'single-card-proven' : 'unknown';
    o.itemProof = { complete: proven, unknownLine: false, conflict: false };
    change(o);
    return capture;
  };
  const SWAPPED = [0, 1, 3, 2];
  beforeEach(() => {
    repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
        description: 'AMAZON SYNTHETIC LINE ORDER', issuerCategory: 'Shopping' }] });
  });
  it('replaces the display over #8\'s reordered lines, so the card charge links and itemizes', async () => {
    const shown = read(1, false), next = read(3, true, SWAPPED);
    expect(compareObservation(next.staging.orders[0], shown.staging.orders[0])).toBe('superset');
    await importAmazonCapture(db(), shown, backup());
    expect(resolution()?.kind).not.toBe('split');
    const before = latest();
    await importAmazonCapture(db(), next, backup());
    expect(latest()).not.toBe(before);
    expect(audits('conflicting-observation-kept-details')).toBe(0);
    expect(shownOrder().items.map(i => [i.asin, i.quantity]))
      .toEqual([['SYNTH00001', 1], ['SYNTH00002', 1], ['SYNTH00004', 1], ['SYNTH00003', 1]]);
    expect(resolution()).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
  });
  it('carries an owner category on a reordered line to its own item, not to the line now at its position', async () => {
    await importAmazonCapture(db(), read(1, false), backup());
    const third = shownOrder().items.find(i => i.asin === 'SYNTH00003')!;
    await backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(third.ref, 'Synthetic owner choice');
    });
    const before = latest();
    await importAmazonCapture(db(), read(3, true, SWAPPED), backup());
    expect(latest()).not.toBe(before);
    expect(audits('item-override-carried')).toBe(1);
    const items = shownOrder().items;
    expect(items.find(i => i.asin === 'SYNTH00003')).toMatchObject({ category: 'Synthetic owner choice', categorySource: 'item-override' });
    expect(items.filter(i => i.categorySource === 'item-override').map(i => i.asin)).toEqual(['SYNTH00003']);
  });
  // Controls: each keeps the display as a conflict, and the card charge is not itemized.
  const TWINS: Line[] = [LINES[0], LINES[1], [null, 'Synthetic twin widget', 240], [null, 'Synthetic twin widget', 260]];
  const SHARED: Line[] = [LINES[0], LINES[1], ['SYNTH00003', 'Synthetic red third widget', 240], ['SYNTH00003', 'Synthetic blue third widget', 260]];
  const controls: Array<[string, () => [ReturnType<typeof read>, ReturnType<typeof read>]]> = [
    ['two lines of one title without ASINs, reordered (which twin is which is unknown)',
      () => [read(1, false, [0, 1, 2, 3], undefined, TWINS), read(3, true, SWAPPED, undefined, TWINS)]],
    ['two lines of one ASIN, reordered', () => [read(1, false, [0, 1, 2, 3], undefined, SHARED), read(3, true, SWAPPED, undefined, SHARED)]],
    ['reordered lines in a read that does not prove its items complete',
      () => [read(1, false), read(3, true, SWAPPED, o => { o.itemProof = { complete: false, unknownLine: false, conflict: false }; })]],
    ['a reordered line whose known price differs', () => [read(1, false), read(3, true, SWAPPED, o => {
      o.items[2].unitPrice = usd(240); o.items[3].unitPrice = usd(260); })]],
    ['reordered lines and a line the display never had', () => [read(1, false), read(3, true, [0, 1, 3, 2, 4])]],
  ];
  it.each(controls)('still keeps the display over %s', async (_, reads) => {
    const [shown, next] = reads();
    expect(compareObservation(next.staging.orders[0], shown.staging.orders[0])).toBe('conflict');
    await importAmazonCapture(db(), shown, backup());
    const before = latest();
    await importAmazonCapture(db(), next, backup());
    expect(latest()).toBe(before);
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(resolution()?.kind).not.toBe('split');
  });
});

describe('display-only item image IDs under order-history policy v3', () => {
  const images = ['91SynthAA0L', '91Synth+01L', '91Synth-02L', 'A1Synth+-3S'];
  const withImages = (capture: ReturnType<typeof complete>, ...ids: string[]) => {
    capture.staging.orders[0].items.forEach((item, n) => { if (ids[n]) item.imageId = ids[n]; });
    return capture;
  };
  const split = () => resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete');
  it('keeps one order allocated across old-kit, new-kit and changed-picture observations', async () => {
    for (const capture of [complete(), withImages(complete(3), images[0], images[1]), withImages(complete(4), images[2])]) {
      await importAmazonCapture(db(), capture, backup());
      expect(split()).toBe(true);
    }
    expect(resolutions().flatMap(r => r.kind === 'split' ? r.contributions : [])
      .reduce((sum, p) => sum + p.amountMinor, 0)).toBe(1100);
    expect(db().prepare("SELECT json_extract(data_json,'$.imageId') FROM amazon_items ORDER BY rowid").pluck().all())
      .toEqual([null, null, images[0], images[1], images[2], null]);
  });
  it.each(['price', 'quantity', 'title', 'asin', 'total', 'summary', 'methods'] as const)(
    'still conflicts on a %s difference while both observations carry different imageIds', field => {
      const a = withImages(complete(), images[0], images[1]).staging.orders[0];
      const b = withImages(complete(3), images[2], images[3]).staging.orders[0];
      const conflicts = () => orderHistoryConflicts([{ order: a }, { order: b }]);
      expect(conflicts()).toBe(false);
      if (field === 'price') b.items[0].unitPrice!.amountMinor = 400;
      if (field === 'quantity') b.items[0].quantity = 2;
      if (field === 'title') changedOrder(b, 'items');
      if (field === 'asin') b.items[0].itemId = 'SYNTH00002';
      if (field === 'total' || field === 'summary' || field === 'methods') changedOrder(b, field);
      expect(conflicts()).toBe(true);
    });
  it('still holds an imported financial difference when both captures show the same pictures', async () => {
    await importAmazonCapture(db(), withImages(complete(), images[0], images[1]), backup());
    const changed = withImages(complete(3), images[0], images[1]);
    changedOrder(changed.staging.orders[0], 'items');
    await importAmazonCapture(db(), changed, backup());
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
  });
});

describe('order-history policy v3 response effects', () => {
  it('derives back the allocation of an order held only by an unproven re-read; a guarded reconcile rewrites no match', async () => {
    const card = readCardInventory(db())[0];
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD',
        amountMinor: 1100, description: 'AMAZON SYNTHETIC TOTAL', issuerCategory: 'Shopping' }] });
    await importAmazonCapture(db(), complete(1, []), backup());
    // A value-first re-read of the matched order that proves only its methods and its total.
    const reread = complete(3, []), o = reread.staging.orders[0];
    o.items = []; o.summary = []; o.tenderCoverage = 'unknown';
    o.itemProof = { complete: false, unknownLine: true, conflict: false };
    o.tenderProof = { methodComplete: true, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false };
    reread.staging.coverage.details = { status: 'held', reason: 'selector-failed', pages: 1, records: 0, rejected: 0 };
    await importAmazonCapture(db(), reread, backup());
    const row = db().prepare('SELECT ref,data_json FROM amazon_subjects').get() as { ref: string; data_json: string };
    const subject = JSON.parse(row.data_json);
    expect(subject.allocationComplete).toBe(true);
    // What order-history policy v2 stored for this order: its subject held as inconsistent evidence.
    subject.allocations = []; subject.allocationComplete = false; subject.allocationHoldReason = 'inconsistent-evidence';
    db().prepare('UPDATE amazon_subjects SET data_json=? WHERE ref=?').run(JSON.stringify(subject), row.ref);
    const cardRow = readLedger(db()).find(r => r.amountMinor === 1100)!;
    // Reads derive the allocation, so the matched card row is itemized again without any write.
    expect(snapshot().resolve([cardRow]).get(cardRow.id)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    expect(snapshot().getCardDetail(cardRow.id)).toMatchObject({ match: 'linked', version: expect.stringMatching(/^amazon-v1-/) });
    // A match row records the link, never the allocation: a guarded reconcile changes no match row and audits nothing.
    const before = { matches: matches(), subjects: db().prepare('SELECT * FROM amazon_subjects').all(), audit: auditCount() };
    expect(await backedUpWrite(db(), backup(), () => reconcileAmazon(db(), '2026-10-22T00:00:00.000Z')))
      .toMatchObject({ newMatches: 0, invalidated: 0 });
    expect(matches()).toEqual(before.matches);
    expect(db().prepare('SELECT * FROM amazon_subjects').all()).toEqual(before.subjects);
    expect(auditCount()).toBe(before.audit);
  });
});

describe('refund progressions under order-history policy v3', () => {
  const withRefund = (capture: ReturnType<typeof complete>, amountMinor: number) => {
    capture.staging.orders[0].refundSummary = { currency: 'USD', amountMinor };
    return capture;
  };
  const orderRow = () => db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get() as
    { latest_digest: string; data_json: string };
  const shownRefund = () => getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.refundSummary;
  const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action) as number;
  const kept = () => audits('conflicting-observation-kept-details') + audits('poorer-observation-kept-details');
  const split = () => resolutions().every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete');
  const view = () => amazonSpending(db(), '2Y', '2026-10-19');
  it('relates a later Refund Total to the displayed one: at least as large updates, smaller conflicts, missing is poorer', () => {
    const shown = withRefund(complete(), 500).staging.orders[0];
    const relation = (refundSummary?: { currency: string; amountMinor: number }) => {
      const next = complete(3).staging.orders[0];
      if (refundSummary) next.refundSummary = refundSummary;
      return compareObservation(next, shown);
    };
    expect(relation({ currency: 'USD', amountMinor: 800 })).toBe('superset');
    expect(relation({ currency: 'USD', amountMinor: 500 })).toBe('superset');
    expect(relation({ currency: 'USD', amountMinor: 300 })).toBe('conflict');
    expect(relation({ currency: 'EUR', amountMinor: 800 })).toBe('conflict');
    expect(relation()).toBe('poorer');
    // A larger Refund Total never makes up for another changed or missing fact.
    const changed = withRefund(complete(3), 800).staging.orders[0];
    changed.items[0].unitPrice = { currency: 'USD', amountMinor: 400 };
    expect(compareObservation(changed, shown)).toBe('conflict');
    const poorer = withRefund(complete(3), 800).staging.orders[0];
    poorer.items[0].itemId = null;
    expect(compareObservation(poorer, shown)).toBe('poorer');
    expect(shown.refundSummary).toEqual({ currency: 'USD', amountMinor: 500 });
  });
  it('replaces the displayed order with a later, larger Refund Total and holds nothing', async () => {
    await importAmazonCapture(db(), withRefund(complete(), 500), backup());
    const before = orderRow();
    expect(split()).toBe(true);
    const receipt = await importAmazonCapture(db(), withRefund(complete(3), 800), backup());
    expect(orderRow().latest_digest).not.toBe(before.latest_digest);
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 800 });
    expect(kept()).toBe(0);
    expect(audits('refund-total-decreased')).toBe(0);
    expect(receipt.holds.map(h => h.reason)).not.toContain('refund-total-decreased');
    expect(audits('order-observation')).toBe(2);
    expect(split()).toBe(true);
    // Netting already counted the latest Refund Total from every observation: the display now agrees with it.
    expect(view().totals[0].refundMinor).toBe(800);
  });
  it('treats an equal Refund Total as a no-op', async () => {
    await importAmazonCapture(db(), withRefund(complete(), 500), backup());
    const before = orderRow();
    await importAmazonCapture(db(), withRefund(complete(3), 500), backup());
    expect(orderRow().data_json).toBe(before.data_json);
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(kept()).toBe(0);
    expect(audits('refund-total-decreased')).toBe(0);
    expect(audits('order-observation')).toBe(1);
    expect(split()).toBe(true);
    expect(view().totals[0].refundMinor).toBe(500);
  });
  it('keeps the displayed order over a smaller Refund Total: a conflict, history only, that holds no purchase allocation', async () => {
    await importAmazonCapture(db(), withRefund(complete(), 500), backup());
    const before = orderRow();
    const smaller = withRefund(complete(3), 300);
    const receipt = await importAmazonCapture(db(), smaller, backup());
    expect(orderRow()).toEqual(before);
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    // Never silent: the import receipt counts it and the audit names the order, under one closed reason.
    expect(receipt.holds).toContainEqual({ reason: 'refund-total-decreased', count: 1 });
    expect(db().prepare("SELECT subject_ref FROM amazon_audit WHERE action='refund-total-decreased'").pluck().all())
      .toEqual([listAmazonOrders(db(), 0, 1).orders[0].ref]);
    // An exact repeat adds nothing.
    await importAmazonCapture(db(), structuredClone(smaller), backup());
    expect(audits('refund-total-decreased')).toBe(1);
    // A refund is never purchase evidence, so the matched card rows stay itemized. Netting, as before, leaves out a
    // Refund Total that went down.
    expect(split()).toBe(true);
    expect(view().totals[0].refundMinor).toBe(0);
    expect(view().refunds.excluded).toContainEqual({ reason: 'contradictory', count: 1 });
  });
  it('flags a Refund Total below an earlier kept one even when it updates the display', async () => {
    await importAmazonCapture(db(), withRefund(complete(), 500), backup());
    // A conflicting read (another line price) carries a larger Refund Total: kept as history, not displayed.
    const conflicting = withRefund(complete(3), 800), o = conflicting.staging.orders[0];
    o.items[0].unitPrice = { currency: 'USD', amountMinor: 400 };
    o.items[1].unitPrice = { currency: 'USD', amountMinor: 600 };
    await importAmazonCapture(db(), conflicting, backup());
    expect(audits('refund-total-decreased')).toBe(0);
    // A superset of the displayed order with 600: an update over the displayed 500, yet below the 800 seen before.
    const receipt = await importAmazonCapture(db(), withRefund(complete(4), 600), backup());
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 600 });
    expect(receipt.holds).toContainEqual({ reason: 'refund-total-decreased', count: 1 });
    expect(audits('refund-total-decreased')).toBe(1);
    expect(view().refunds.excluded).toContainEqual({ reason: 'contradictory', count: 1 });
  });
  it('keeps a changed line price a conflict that holds the allocation, even beside a larger Refund Total', async () => {
    await importAmazonCapture(db(), withRefund(complete(), 500), backup());
    const before = orderRow();
    const changed = withRefund(complete(3), 800), o = changed.staging.orders[0];
    o.items[0].unitPrice = { currency: 'USD', amountMinor: 400 };
    o.items[1].unitPrice = { currency: 'USD', amountMinor: 600 };
    await importAmazonCapture(db(), changed, backup());
    expect(orderRow()).toEqual(before);
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    // Both reads prove their item lists, and their prices differ: the purchase allocation is held.
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
  });
  const refundStated = (status: 'pending' | 'completed') => status === 'completed'
    ? syntheticEvidence({ money: { currency: 'USD', amountMinor: 500 } })
    : syntheticEvidence({ status: 'pending', money: null, date: null,
      provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-pending' } } as Partial<RefundEvidence>);
  it('keeps the display over a larger Refund Total read with its refund taken back to pending: a flagged conflict (review repro)', async () => {
    await importAmazonCapture(db(), withRefundEvidence(withRefund(complete(), 500), [refundStated('completed')]), backup());
    const before = orderRow();
    const receipt = await importAmazonCapture(db(), withRefundEvidence(withRefund(complete(3), 800), [refundStated('pending')]),
      backup());
    // The display decision consults the event projection: a status taken back is never a progression.
    expect(orderRow()).toEqual(before);
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(audits('refund-status-regressed')).toBe(1);
    expect(receipt.holds).toContainEqual({ reason: 'refund-status-regressed', count: 1 });
    expect(listRefundEvents(db())).toEqual([expect.objectContaining({ status: 'completed', conflict: true, observations: 2 })]);
    // A refund-side anomaly never strips the purchase itemization.
    expect(split()).toBe(true);
  });
  it('lets a read whose refund advances from pending to completed, with a larger Refund Total, update the display', async () => {
    await importAmazonCapture(db(), withRefundEvidence(complete(), [refundStated('pending')]), backup());
    const before = orderRow();
    const receipt = await importAmazonCapture(db(), withRefundEvidence(withRefund(complete(3), 500), [refundStated('completed')]),
      backup());
    expect(orderRow().latest_digest).not.toBe(before.latest_digest);
    expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(kept()).toBe(0);
    expect(audits('refund-status-regressed')).toBe(0);
    expect(receipt.holds.map(h => h.reason)).not.toContain('refund-status-regressed');
    expect(listRefundEvents(db())).toEqual([expect.objectContaining({ status: 'completed', conflict: false, observations: 2 })]);
    expect(split()).toBe(true);
  });
  // The deploy boundary (review repro): #155's v1 projection kept each event's latest status, so a status already taken
  // back reads as reached there. What an event reached is rebuilt from every retained observation instead, never read
  // from a projection an earlier policy wrote: the first v3 import decides alike whether or not a reconcile ran first.
  const returnPhrases = { 'in-transit': 'return-in-transit', received: 'return-received', completed: 'return-complete',
    cancelled: 'return-cancelled' } as const;
  const returnStated = (status: keyof typeof returnPhrases) => syntheticEvidence({ kind: 'return', status, money: null, date: null,
    provenance: { source: 'order-details', page: 0, ordinal: 1, phrase: returnPhrases[status] } } as Partial<RefundEvidence>);
  const sequences: Array<[string, () => RefundEvidence, () => RefundEvidence]> = [
    ['a refund completed, then pending', () => refundStated('completed'), () => refundStated('pending')],
    ['a return received, then in transit', () => returnStated('received'), () => returnStated('in-transit')],
    ['a return completed, then cancelled', () => returnStated('completed'), () => returnStated('cancelled')],
  ];
  it.each(sequences.flatMap(([name, reached, back]) => [false, true].map(first => [name, first, reached, back] as const)))(
    'keeps the display over the first v3 read of %s under a v1 projection (reconcile first: %s)',
    async (_, reconcileFirst, reached, back) => {
      const now = '2026-10-19T12:00:00.000Z', { kind, status } = reached();
      await importAmazonCapture(db(), withRefundEvidence(withRefund(complete(), 500), [reached()]), backup());
      await importAmazonCapture(db(), withRefundEvidence(withRefund(complete(3), 700), [back()]), backup());
      // What #155's v1 projection left behind: the latest stated status, and no status conflict.
      await backedUpWrite(db(), backup(), () => db().prepare(`UPDATE amazon_refund_events SET status=?,
        data_json=json_set(data_json,'$.status',?,'$.conflict',json('false')) WHERE kind=?`).run(back().status, back().status, kind));
      expect(listRefundEvents(db())).toEqual([expect.objectContaining({ kind, status: back().status, conflict: false })]);
      if (reconcileFirst) await backedUpWrite(db(), backup(), () => { projectRefunds(db(), now); return reconcileAmazon(db(), now); });
      const before = orderRow(), keptBefore = kept(), regressions = audits('refund-status-regressed');
      const receipt = await importAmazonCapture(db(), withRefundEvidence(withRefund(complete(4), 800), [back()]), backup());
      expect(orderRow()).toEqual(before);
      expect(shownRefund()).toEqual({ currency: 'USD', amountMinor: 500 });
      expect(kept() - keptBefore).toBe(1);
      expect(audits('refund-status-regressed') - regressions).toBe(1);
      expect(receipt.holds).toContainEqual({ reason: 'refund-status-regressed', count: 1 });
      expect(listRefundEvents(db())).toEqual([expect.objectContaining({ kind, status, conflict: true, observations: 3 })]);
      expect(split()).toBe(true);
    });
});

describe('order-history policy v3: an unread value or another order is never a conflict (review repros)', () => {
  const cardRow = (amountMinor: number) => readLedger(db()).find(r => r.amountMinor === amountMinor)!;
  const bindSecondCard = async (amountMinor: number) => {
    const second = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9002', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: second.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor,
        description: 'AMAZON SYNTHETIC SECOND CARD', issuerCategory: 'Shopping' }] });
    const cards = readCardInventory(db());
    const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
  };
  const addRow = (amountMinor: number) => repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id,
    source: 'synthetic', parserVersion: 'synthetic@1', rows: [{ transactionDate: '2026-09-03', status: 'posted',
      kind: 'purchase', currency: 'USD', amountMinor, description: `AMAZON SYNTHETIC ${amountMinor}`, issuerCategory: 'Shopping' }] });
  it.each(['learned', 'lost'] as const)('never holds an order whose complete item list re-read %s an unread ASIN', async direction => {
    addRow(1100);
    const read = (run: number, asin: string | null) => {
      const capture = complete(run, []), o = capture.staging.orders[0];
      o.items[0].itemId = asin; o.items[1].itemId = 'SYNTH00002';
      return capture;
    };
    const [first, second] = direction === 'learned' ? [read(1, null), read(3, 'SYNTH00001')] : [read(1, 'SYNTH00001'), read(3, null)];
    expect(compareObservation(second.staging.orders[0], first.staging.orders[0]))
      .toBe(direction === 'learned' ? 'superset' : 'poorer');
    await importAmazonCapture(db(), first, backup());
    expect(snapshot().resolve([cardRow(1100)]).get(cardRow(1100).id)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    await importAmazonCapture(db(), second, backup());
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.items.map(i => i.asin)).toEqual(['SYNTH00001', 'SYNTH00002']);
    expect(snapshot().resolve([cardRow(1100)]).get(cardRow(1100).id)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    // A known ASIN that differs is still a proven conflict, and an unread one between two never hides it.
    await importAmazonCapture(db(), read(4, 'SYNTH00009'), backup());
    expect(snapshot().resolve([cardRow(1100)]).get(cardRow(1100).id)).toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
  });
  it('never holds an order whose complete two-card method list is re-read in another order', async () => {
    await bindSecondCard(500);
    const read = (run: number, last4s: string[]) => {
      const capture = syntheticCapture(), o = capture.staging.orders[0];
      capture.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
      o.itemProof = { complete: true, unknownLine: false, conflict: false };
      o.tenderCoverage = 'multi-tender';
      o.paymentMethods = last4s.map(last4 => ({ kind: 'card' as const, network: 'visa' as const, last4 }));
      capture.staging.payments = [600, 500].map((amountMinor, ordinal): PaymentObservation => ({ date: '2026-09-03',
        money: { currency: 'USD', amountMinor }, kind: 'charge', status: 'completed',
        method: { kind: 'card', network: 'visa', last4: ordinal ? '9002' : '9001' }, orderIds: [o.orderId],
        identity: 'native-row', provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal } }));
      capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 2, rejected: 0 };
      return capture;
    };
    const split = () => {
      const all = resolutions();
      return all.length === 2 && all.every(r => r.kind === 'split' && r.evidenceClass === 'payment-ledger-complete');
    };
    const first = read(1, ['9001', '9002']), reordered = read(3, ['9002', '9001']);
    expect(compareObservation(reordered.staging.orders[0], first.staging.orders[0])).toBe('superset');
    await importAmazonCapture(db(), first, backup());
    expect(split()).toBe(true);
    await importAmazonCapture(db(), reordered, backup());
    expect(split()).toBe(true);
    // A known instrument that differs is still a proven conflict.
    await importAmazonCapture(db(), read(4, ['9001', '9003']), backup());
    expect(resolutions().every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
  });
  it('never holds an order whose complete card and gift-card method list is re-read in another order', async () => {
    addRow(1000);
    const read = (run: number, reversed: boolean) => {
      const capture = syntheticCapture(), o = capture.staging.orders[0];
      capture.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
      o.itemProof = { complete: true, unknownLine: false, conflict: false };
      o.tenderCoverage = 'multi-tender';
      o.paymentMethods!.push({ kind: 'balance', network: 'unknown', last4: null });
      if (reversed) o.paymentMethods!.reverse();
      o.summary!.push({ kind: 'gift-card', money: { currency: 'USD', amountMinor: -100 } });
      capture.staging.payments = [{ date: '2026-09-03', money: { currency: 'USD', amountMinor: 1000 }, kind: 'charge',
        status: 'completed', method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [o.orderId],
        identity: 'native-row', provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal: 0 } }];
      capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
      return capture;
    };
    const first = read(1, false), reordered = read(3, true);
    expect(compareObservation(reordered.staging.orders[0], first.staging.orders[0])).toBe('superset');
    await importAmazonCapture(db(), first, backup());
    expect(snapshot().resolve([cardRow(1000)]).get(cardRow(1000).id)).toMatchObject({ kind: 'split', evidenceClass: 'payment-ledger-complete' });
    await importAmazonCapture(db(), reordered, backup());
    expect(snapshot().resolve([cardRow(1000)]).get(cardRow(1000).id)).toMatchObject({ kind: 'split', evidenceClass: 'payment-ledger-complete' });
  });
});

describe('display replacement preserves owner decisions (#168)', () => {
  const cardRow = () => readLedger(db()).find(r => r.amountMinor === 1100)!;
  const read = (run: number, change: (o: OrderObservation) => void = () => undefined) => {
    const capture = complete(run, []), o = capture.staging.orders[0];
    o.items[1].itemId = 'SYNTH00002';
    change(o);
    return capture;
  };
  const shownOrder = () => getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
  // The owner's category for the first displayed line, and the agent's for the second (by product).
  const decide = (owner: string[] = ['Synthetic owner choice']) => backedUpWrite(db(), backup(), () => {
    const items = shownOrder().items;
    owner.forEach((category, n) => db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(items[n].ref, category));
    if (owner.length === 1) {
      const line = db().prepare('SELECT data_json FROM amazon_items WHERE ref=?').pluck().get(items[1].ref) as string;
      const item = JSON.parse(line) as { itemId: string | null; title: string };
      db().prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)')
        .run(productKey({ asin: item.itemId, title: item.title }), 'Shopping', 0.9, 'agent', 'categorized from product title');
    }
  });
  const measures = () => {
    const view = amazonSpending(db(), '2Y', '2026-10-19'), snap = snapshot(), split = snap.resolve([cardRow()]).get(cardRow().id);
    return { categorizedMinor: view.totals[0].categorizedMinor, categories: view.categories, itemized: view.cardCharges.itemized,
      itemizedRows: snap.matchCounts.itemizedRows, items: shownOrder().items.map(i => [i.category, i.categorySource]),
      parts: split?.kind === 'split' ? split.contributions.map(p => [p.category, p.categorySource, p.classification, p.amountMinor]) : split };
  };
  const latest = () => db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get();
  const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action) as number;
  // One order's line learns ASIN SYNTH00003 under its title; another order's line already had that ASIN under another
  // title, and its re-read shows the first title. Both lines map to one new product key.
  const learning = (run: number, asin: string | null) => read(run, o => { o.items[1].itemId = asin; });
  const other = (run: number, otherTitle: string) => read(run, o => {
    o.orderId = '000-0000001-0000002'; o.items[1].itemId = 'SYNTH00003'; o.items[1].title = otherTitle;
  });
  const categorize = (key: string, category: string, confidence: number) => db()
    .prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)').run(key, category, confidence, 'agent', 'categorized from product title');
  const agentRow = (key: string) => db().prepare('SELECT category,confidence,source,rationale FROM amazon_agent_categories WHERE product_key=?')
    .get(key);
  // A card row whose owner category puts `category` in the card category inventory, until the owner changes it.
  const ownerCategory = (category: string) => {
    repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-04', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 777,
        description: 'SYNTHETIC HOUSEHOLD', issuerCategory: 'Shopping' }] });
    const id = db().prepare('SELECT id FROM card_transactions WHERE amount_minor=777').pluck().get() as string;
    const set = (value: string) => repo.updateCardTransaction(id, { userCategory: value }, { actorRef: cardSyncActorRef('synthetic-owner') });
    set(category);
    return set;
  };
  // Every Amazon and card table, to show a refused adoption writes nothing.
  const tables = () => Object.fromEntries((db().prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND (name LIKE 'amazon%' OR name LIKE 'card%') ORDER BY name`).pluck().all() as string[])
    .map(name => [name, db().prepare(`SELECT * FROM "${name}"`).all()]));
  // Applies an adoption as the GO'd review does, inside a backed-up write: its counts if it was stale, else null.
  const adopt = async (adoption: unknown): Promise<AdoptionCounts | null> => {
    const reported: { counts?: AdoptionCounts } = {};
    try {
      await backedUpWrite(db(), backup(), () => applyCategoryAdoption(db(), adoption, counts => { reported.counts = counts; }));
    } catch (error) {
      if (!reported.counts) throw error;
    }
    return reported.counts ?? null;
  };
  beforeEach(() => {
    repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
        description: 'AMAZON SYNTHETIC OWNER', issuerCategory: 'Shopping' }] });
  });
  it.each([
    ['a refund progression', (o: OrderObservation) => { o.refundSummary = { currency: 'USD', amountMinor: 800 }; }],
    ['a superset re-read', (o: OrderObservation) => { o.items[0].imageId = '91SynthAA0L'; }],
  ])('carries the owner category to the new display over %s, with every total unchanged', async (_, change) => {
    await importAmazonCapture(db(), read(1, o => { o.refundSummary = { currency: 'USD', amountMinor: 500 }; }), backup());
    await decide();
    const before = measures(), shown = latest();
    expect(before.items).toEqual([['Synthetic owner choice', 'item-override'], ['Shopping', 'agent-classification']]);
    expect(before.itemizedRows).toBe(1);
    await importAmazonCapture(db(), read(3, o => { o.refundSummary = { currency: 'USD', amountMinor: 500 }; change(o); }), backup());
    expect(latest()).not.toBe(shown);
    expect(measures()).toEqual(before);
    expect(audits('item-override-carried')).toBe(1);
    expect(db().prepare('SELECT count(*) FROM amazon_item_overrides').pluck().get()).toBe(2);
  });
  it('keeps the display when identical lines carry different owner categories, as a flagged conflict', async () => {
    const identical = (o: OrderObservation) => { o.items[1].itemId = o.items[0].itemId; o.items[1].title = o.items[0].title; };
    await importAmazonCapture(db(), read(1, identical), backup());
    await decide(['Synthetic owner first', 'Synthetic owner second']);
    const before = measures(), shown = latest();
    const receipt = await importAmazonCapture(db(), read(3, o => { identical(o); o.items[0].imageId = '91SynthAA0L'; }), backup());
    expect(latest()).toBe(shown);
    expect(measures()).toEqual(before);
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(audits('item-category-unmatched')).toBe(1);
    expect(audits('item-override-carried')).toBe(0);
    expect(receipt.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
  });
  it('keeps the allocation on the display over a poorer complete re-read, so the owner category still applies', async () => {
    await importAmazonCapture(db(), read(1, o => { o.refundSummary = { currency: 'USD', amountMinor: 500 }; }), backup());
    await decide();
    const before = measures(), shown = latest();
    await importAmazonCapture(db(), read(3), backup());
    expect(latest()).toBe(shown);
    expect(audits('poorer-observation-kept-details')).toBe(1);
    expect(measures()).toEqual(before);
  });
  it('keeps the display when a learned ASIN would change a line\'s agent category, until a review adopts the new key', async () => {
    await importAmazonCapture(db(), read(1, o => { o.items[1].itemId = null; }), backup());
    await decide();
    const before = measures(), shown = latest();
    expect(before.items[1]).toEqual(['Shopping', 'agent-classification']);
    const receipt = await importAmazonCapture(db(), read(3), backup());
    expect(latest()).toBe(shown);
    expect(measures()).toEqual(before);
    expect(audits('item-category-unmatched')).toBe(1);
    // Counted per line, and listed for the next GO'd category review with the same category: never written by the importer.
    expect(receipt.holds).toContainEqual({ reason: 'agent-category-new-key', count: 1 });
    expect(receipt.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
    const title = read(3).staging.orders[0].items[1].title, adoptions = categoryKeyAdoptions(db());
    expect(adoptions).toEqual([{ productKey: productKey({ asin: 'SYNTH00002', title }),
      previousProductKey: productKey({ asin: null, title }), category: 'Shopping', confidence: 0.9 }]);
    expect(db().prepare('SELECT count(*) FROM amazon_agent_categories').pluck().get()).toBe(1);
    // adoption-review's adoption: exactly the listed key, with its old key and the adopted category and confidence.
    const { review, ambiguous, outsideInventory } = adoptionReview(db());
    expect({ ambiguous, outsideInventory }).toEqual({ ambiguous: 0, outsideInventory: 0 });
    expect(review).toEqual({ kind: 'adoption', productsDigest: digest(adoptions), categoriesDigest: digest(['Shopping']),
      entries: adoptions });
    // It applies only inside a write transaction, and an empty adoption is refused like any malformed review.
    expect(() => applyCategoryAdoption(db(), review, () => undefined)).toThrow('amazon input refused');
    await expect(adopt({ ...review, productsDigest: digest([]), entries: [] })).rejects.toThrow('amazon input refused');
    expect(db().prepare('SELECT count(*) FROM amazon_agent_categories').pluck().get()).toBe(1);
    expect(await adopt(review)).toBeNull();
    expect(agentRow(adoptions[0].productKey))
      .toEqual({ category: 'Shopping', confidence: 0.9, source: 'agent', rationale: 'categorized from product title' });
    expect(categoryKeyAdoptions(db())).toEqual([]);
    expect(adoptionReview(db())).toMatchObject({ review: { entries: [] }, ambiguous: 0, outsideInventory: 0 });
    // The order's next re-read then replaces the display, with every category and total unchanged.
    const next = await importAmazonCapture(db(), read(5), backup());
    expect(latest()).not.toBe(shown);
    expect(measures()).toEqual(before);
    expect(next.holds.map(h => h.reason)).not.toContain('agent-category-new-key');
    expect(audits('item-override-carried')).toBe(1);
  });
  it('never offers a learned key the agent already categorized differently: the display stays, for the owner', async () => {
    await importAmazonCapture(db(), read(1, o => { o.items[1].itemId = null; }), backup());
    await decide();
    const title = read(3).staging.orders[0].items[1].title, learned = productKey({ asin: 'SYNTH00002', title });
    // The agent already categorized the learned key, differently (as another order's line with that ASIN, say).
    db().prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)')
      .run(learned, 'Synthetic agent choice', 0.7, 'agent', 'categorized from product title');
    const before = measures(), shown = latest();
    const receipt = await importAmazonCapture(db(), read(3), backup());
    expect(latest()).toBe(shown);
    expect(measures()).toEqual(before);
    expect(audits('item-category-unmatched')).toBe(1);
    expect(receipt.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
    expect(receipt.holds.map(h => h.reason)).not.toContain('agent-category-new-key');
    expect(categoryKeyAdoptions(db())).toEqual([]);
    expect(adoptionReview(db())).toMatchObject({ review: { entries: [] }, ambiguous: 0, outsideInventory: 0 });
    expect(db().prepare('SELECT category FROM amazon_agent_categories WHERE product_key=?').pluck().get(learned))
      .toBe('Synthetic agent choice');
    // The owner resolves it: an item override on the displayed line follows the next re-read, which replaces the display.
    await backedUpWrite(db(), backup(), () => db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)')
      .run(shownOrder().items[1].ref, 'Shopping'));
    const next = await importAmazonCapture(db(), read(5), backup());
    expect(latest()).not.toBe(shown);
    expect(next.holds.map(h => h.reason)).not.toContain('item-category-unmatched');
    expect(shownOrder().items.map(i => [i.category, i.categorySource]))
      .toEqual([['Synthetic owner choice', 'item-override'], ['Shopping', 'item-override']]);
    expect(db().prepare('SELECT category FROM amazon_agent_categories WHERE product_key=?').pluck().get(learned))
      .toBe('Synthetic agent choice');
  });
  it('counts a listed key whose category left the card category inventory, and leaves it out of the review', async () => {
    await importAmazonCapture(db(), read(1, o => { o.items[1].itemId = null; }), backup());
    // No card row has the agent's category for the displayed line (card rows are guarded, so it is set directly).
    const title = read(1).staging.orders[0].items[1].title;
    db().prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)').run(productKey({ asin: null, title }),
      'Synthetic retired category', 0.6, 'agent', 'categorized from product title');
    const receipt = await importAmazonCapture(db(), read(3), backup());
    expect(receipt.holds).toContainEqual({ reason: 'agent-category-new-key', count: 1 });
    expect(categoryKeyAdoptions(db())).toEqual([{ productKey: productKey({ asin: 'SYNTH00002', title }),
      previousProductKey: productKey({ asin: null, title }), category: 'Synthetic retired category', confidence: 0.6 }]);
    expect(adoptionReview(db())).toEqual({ review: { kind: 'adoption', productsDigest: digest([]),
      categoriesDigest: digest(['Shopping']), entries: [] }, ambiguous: 0, outsideInventory: 1 });
  });
  it('leaves out, and counts, a learned key that two displayed agent categories would claim', async () => {
    repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-04', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 777,
        description: 'SYNTHETIC HOUSEHOLD', issuerCategory: 'Synthetic household' }] });
    const title = read(1).staging.orders[0].items[1].title;
    await importAmazonCapture(db(), learning(1, null), backup());
    await importAmazonCapture(db(), other(3, 'Synthetic third widget'), backup());
    categorize(productKey({ asin: null, title }), 'Shopping', 0.9);
    categorize(productKey({ asin: 'SYNTH00003', title: 'Synthetic third widget' }), 'Synthetic household', 0.8);
    for (const capture of [learning(5, 'SYNTH00003'), other(7, title)]) {
      expect((await importAmazonCapture(db(), capture, backup())).holds).toContainEqual({ reason: 'agent-category-new-key', count: 1 });
    }
    expect(categoryKeyAdoptions(db())).toEqual([]);
    expect(adoptionReview(db())).toEqual({ review: { kind: 'adoption', productsDigest: digest([]),
      categoriesDigest: digest(['Shopping', 'Synthetic household']), entries: [] }, ambiguous: 1, outsideInventory: 0 });
  });
  it('merges lines that agree on a key\'s category at their lowest confidence, with that line\'s old key, so it applies', async () => {
    const title = read(1).staging.orders[0].items[1].title, learned = productKey({ asin: 'SYNTH00003', title });
    const mine = productKey({ asin: null, title }), theirs = productKey({ asin: 'SYNTH00003', title: 'Synthetic third widget' });
    await importAmazonCapture(db(), learning(1, null), backup());
    await importAmazonCapture(db(), other(3, 'Synthetic third widget'), backup());
    // The order the list reads first holds the higher confidence, so the lowest is seen second.
    const oneFirst = opaque('order', '000-0000001-0000001') < opaque('order', '000-0000001-0000002');
    categorize(mine, 'Shopping', oneFirst ? 0.9 : 0.7);
    categorize(theirs, 'Shopping', oneFirst ? 0.7 : 0.9);
    for (const capture of [learning(5, 'SYNTH00003'), other(7, title)]) await importAmazonCapture(db(), capture, backup());
    const adoptions = categoryKeyAdoptions(db());
    expect(adoptions).toEqual([{ productKey: learned, previousProductKey: oneFirst ? theirs : mine, category: 'Shopping',
      confidence: 0.7 }]);
    expect(await adopt(adoptionReview(db()).review)).toBeNull();
    expect(agentRow(learned)).toEqual({ category: 'Shopping', confidence: 0.7, source: 'agent', rationale: 'categorized from product title' });
  });
  it('refuses, with no writes, an adoption whose key another displayed category claims since it was written', async () => {
    ownerCategory('Synthetic household');
    const title = read(1).staging.orders[0].items[1].title;
    await importAmazonCapture(db(), learning(1, null), backup());
    await importAmazonCapture(db(), other(3, 'Synthetic third widget'), backup());
    categorize(productKey({ asin: null, title }), 'Shopping', 0.9);
    categorize(productKey({ asin: 'SYNTH00003', title: 'Synthetic third widget' }), 'Synthetic household', 0.8);
    await importAmazonCapture(db(), learning(5, 'SYNTH00003'), backup());
    const { review } = adoptionReview(db());
    expect(review.entries).toEqual([{ productKey: productKey({ asin: 'SYNTH00003', title }),
      previousProductKey: productKey({ asin: null, title }), category: 'Shopping', confidence: 0.9 }]);
    // Another order's re-read now claims the same key for another category: the key is ambiguous, so the adoption is stale.
    await importAmazonCapture(db(), other(7, title), backup());
    const before = tables();
    expect(await adopt(review)).toEqual({ entries: 1, stale: 1 });
    expect(tables()).toEqual(before);
  });
  it('refuses, with no writes, an adoption whose category left the card category inventory since it was written', async () => {
    const recategorize = ownerCategory('Synthetic household');
    await importAmazonCapture(db(), read(1, o => { o.items[1].itemId = null; }), backup());
    const title = read(1).staging.orders[0].items[1].title;
    categorize(productKey({ asin: null, title }), 'Synthetic household', 0.8);
    await importAmazonCapture(db(), read(3), backup());
    const { review } = adoptionReview(db());
    expect(review.entries).toEqual([{ productKey: productKey({ asin: 'SYNTH00002', title }),
      previousProductKey: productKey({ asin: null, title }), category: 'Synthetic household', confidence: 0.8 }]);
    recategorize('Synthetic other');
    const before = tables();
    expect(await adopt(review)).toEqual({ entries: 1, stale: 1 });
    expect(tables()).toEqual(before);
  });
  it('refuses a malformed adoption like any malformed review', () => {
    const entry = { productKey: 'b'.repeat(64), previousProductKey: 'a'.repeat(64), category: 'Shopping', confidence: 0.5 };
    const valid = { kind: 'adoption', productsDigest: digest([entry]), categoriesDigest: digest(['Shopping']), entries: [entry] };
    expect(validateCategoryAdoption(valid)).toEqual(valid);
    const entries = (list: unknown[]) => ({ ...valid, productsDigest: digest(list), entries: list });
    for (const bad of [
      { ...valid, extra: 1 },
      { kind: 'adoption', productsDigest: valid.productsDigest, entries: [entry] },
      { ...valid, kind: 'agent-classification' },
      { ...valid, productsDigest: digest([]) },
      { ...valid, categoriesDigest: 'not a digest' },
      entries([{ ...entry, source: 'agent' }]),
      entries([{ ...entry, previousProductKey: entry.productKey }]),
      entries([{ ...entry, productKey: 'B'.repeat(64) }]),
      entries([entry, entry]),
      entries([{ ...entry, productKey: 'c'.repeat(64) }, entry]),
      entries([{ ...entry, category: 'Synthetic <category>' }]),
      entries([{ ...entry, confidence: 1.5 }]),
      entries([{ ...entry, confidence: Number.NaN }]),
    ]) expect(() => validateCategoryAdoption(bad)).toThrow('amazon input refused');
  });
  describe('an adoption holds at application time (Root)', () => {
    // Two lines learn their ASINs, so the adoption has two entries; another connection then changes one of them.
    const twoLines = async () => {
      await importAmazonCapture(db(), read(1, o => { o.items[0].itemId = null; o.items[1].itemId = null; }), backup());
      const [first, second] = read(1).staging.orders[0].items.map(i => i.title);
      categorize(productKey({ asin: null, title: first }), 'Shopping', 0.9);
      categorize(productKey({ asin: null, title: second }), 'Shopping', 0.8);
      await importAmazonCapture(db(), read(3), backup());
      const { review } = adoptionReview(db());
      expect(review.entries).toHaveLength(2);
      return review;
    };
    const elsewhere = (sql: string, ...values: unknown[]) => {
      const other = new Database(path.join(dir, 'synthetic.db'));
      try { other.prepare(sql).run(...values); } finally { other.close(); }
    };
    it.each([
      ['its new key gets the same agent category', (e: CategoryKeyAdoption) => elsewhere(
        'INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)', e.productKey, e.category, e.confidence, 'agent', 'categorized from product title')],
      ['its new key gets another agent category', (e: CategoryKeyAdoption) => elsewhere(
        'INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)', e.productKey, 'Synthetic other', 0.6, 'agent', 'categorized from product title')],
      ['its old key\'s category changes', (e: CategoryKeyAdoption) => elsewhere(
        'UPDATE amazon_agent_categories SET category=? WHERE product_key=?', 'Synthetic other', e.previousProductKey)],
      ['its old key\'s confidence changes', (e: CategoryKeyAdoption) => elsewhere(
        'UPDATE amazon_agent_categories SET confidence=? WHERE product_key=?', 0.35, e.previousProductKey)],
      ['its old key\'s agent category is deleted', (e: CategoryKeyAdoption) => elsewhere(
        'DELETE FROM amazon_agent_categories WHERE product_key=?', e.previousProductKey)],
    ])('refuses the whole adoption, with no writes, when one entry goes stale: %s', async (_, change) => {
      const review = await twoLines();
      change(review.entries[1]);
      const before = tables();
      expect(await adopt(review)).toEqual({ entries: 2, stale: 1 });
      expect(tables()).toEqual(before);
      expect(agentRow(review.entries[0].productKey)).toBeUndefined();
    });
    it('sees a row another connection commits after the pre-write backup, before the write transaction', async () => {
      const review = await twoLines(), target = review.entries[1];
      const backupOf = db().backup.bind(db());
      let before: unknown;
      Object.defineProperty(db(), 'backup', { configurable: true, value: async (...args: Parameters<typeof backupOf>) => {
        const done = await backupOf(...args);
        elsewhere('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)', target.productKey, 'Synthetic other', 0.6, 'agent',
          'categorized from product title');
        before = tables();
        return done;
      } });
      try {
        expect(await adopt(review)).toEqual({ entries: 2, stale: 1 });
      } finally { Reflect.deleteProperty(db(), 'backup'); }
      expect(before).toBeDefined();
      expect(tables()).toEqual(before);
      expect(agentRow(target.productKey)).toMatchObject({ category: 'Synthetic other', confidence: 0.6 });
    });
    it('applies exactly the adopted values when every entry is still current', async () => {
      const review = await twoLines(), before = tables();
      expect(await adopt(review)).toBeNull();
      const after = tables();
      expect(after.amazon_agent_categories).toEqual([...before.amazon_agent_categories as unknown[], ...review.entries.map(e => ({
        product_key: e.productKey, category: e.category, confidence: e.confidence, source: 'agent',
        rationale: 'categorized from product title' }))]);
      expect(Object.keys(after).filter(name => JSON.stringify(after[name]) !== JSON.stringify(before[name])))
        .toEqual(['amazon_agent_categories']);
    });
  });
});

describe('stable rounding ties under order-history policy v3 (review repro)', () => {
  // Two $1 lines and a one-cent tax, in two owner categories: the cent's remainder ties between the lines. The order-total
  // anchor allocates the order's one card row; a split ledger payment (101 + 100) allocates two rows, the first tie in
  // what the charges together cover.
  it.each([['order-total', []], ['payment-ledger', [101, 100]]] as const)(
    'keeps every category total over display-only re-reads (%s anchor)', async (anchor, charges) => {
      const amounts = charges.length ? [...charges] : [201];
      repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id, source: 'synthetic', parserVersion: 'synthetic@1',
        rows: amounts.map((amountMinor, n) => ({ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase',
          currency: 'USD', amountMinor, description: `AMAZON SYNTHETIC TIE ${n}`, issuerCategory: 'Shopping' })) });
      const read = (run: number) => {
        const capture = complete(run, [...charges]), o = capture.staging.orders[0];
        o.items[1].itemId = 'SYNTH00002';
        o.items.forEach(item => { item.unitPrice = { currency: 'USD', amountMinor: 100 }; });
        o.summary = [{ kind: 'items-subtotal', money: { currency: 'USD', amountMinor: 200 } },
          { kind: 'shipping', money: { currency: 'USD', amountMinor: 0 } }, { kind: 'tax', money: { currency: 'USD', amountMinor: 1 } },
          { kind: 'grand-total', money: { currency: 'USD', amountMinor: 201 } }];
        o.total = { currency: 'USD', amountMinor: 201 };
        if (run > 1) o.items[run % 2].imageId = '91SynthAA0L';
        return capture;
      };
      await importAmazonCapture(db(), read(1), backup());
      await backedUpWrite(db(), backup(), () => {
        const items = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.items;
        items.forEach((item, n) => db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)')
          .run(item.ref, n ? 'Synthetic beta' : 'Synthetic alpha'));
      });
      const evidence = anchor === 'payment-ledger' ? 'payment-ledger-complete' : 'unique-total-match';
      const totals = () => {
        const rows = readLedger(db()).filter(r => amounts.includes(r.amountMinor)), resolved = snapshot().resolve(rows);
        const sums: Record<string, number> = {};
        for (const r of rows) {
          const split = resolved.get(r.id)!;
          expect({ kind: split.kind, evidenceClass: split.kind === 'split' ? split.evidenceClass : split.reason })
            .toEqual({ kind: 'split', evidenceClass: evidence });
          if (split.kind === 'split') for (const part of split.contributions) sums[part.category!] = (sums[part.category!] ?? 0) + part.amountMinor;
        }
        return sums;
      };
      const before = totals();
      expect(Object.values(before).sort()).toEqual([100, 101]);
      const view = () => amazonSpending(db(), '2Y', '2026-10-19').categories;
      const shownView = view();
      for (let run = 2; run <= 9; run++) {
        const shown = db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get();
        await importAmazonCapture(db(), read(run), backup());
        expect(db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get()).not.toBe(shown);
        expect(totals()).toEqual(before);
        expect(view()).toEqual(shownView);
      }
    });
});
