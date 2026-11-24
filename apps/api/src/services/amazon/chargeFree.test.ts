import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { runAmazonCli } from '../../cli/amazon.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { orderObservationScope, validateCapture } from './capture.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { digest, LEDGER_POLICY_DIGEST, opaque, POLICY_DIGEST } from './policy.js';
import { AMAZON_SCHEMA_DIGEST } from './schema.js';
import { rootApproval, syntheticCapture } from './fixtures.testSupport.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { amazonSpending } from './spending.js';
import type { OrderObservation, PaymentObservation } from './types.js';

// Synthetic only: a detailed order, then Amazon's closed positive statement that it was cancelled and never charged.
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
function header(run = 2) {
  const capture = complete(run, []), order = capture.staging.orders[0];
  order.items = []; order.paymentMethods = []; order.summary = []; order.tenderCoverage = 'unknown';
  delete order.itemProof;
  order.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false };
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
function proven(run = 5, shipments = 1) {
  const capture = header(run), order = capture.staging.orders[0];
  order.total = null;
  order.chargeFree = { status: 'cancelled-not-charged', shipments };
  return capture;
}
// Ledger rows naming the order, in the shape the kit stages them.
function charged<T extends ReturnType<typeof complete>>(capture: T, amounts: number[]): T {
  const order = capture.staging.orders[0];
  capture.staging.payments = amounts.map((amountMinor, ordinal): PaymentObservation => ({
    date: '2026-09-03', money: { currency: 'USD', amountMinor }, kind: 'charge', status: 'completed',
    method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [order.orderId], identity: 'native-row',
    provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal },
  }));
  capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: amounts.length, rejected: 0 };
  return capture;
}

describe('charge-free proof contract', () => {
  it('accepts the closed proof only on an empty-details order with no total, as a header observation', async () => {
    for (const shipments of [1, 100]) {
      const validated = await validateCapture(proven(5, shipments));
      expect(validated.staging.orders[0].chargeFree).toEqual({ status: 'cancelled-not-charged', shipments });
      expect(orderObservationScope(validated.structure, validated.staging.orders[0], 0)).toBe('header-only');
    }
  });
  const detailed = () => complete().staging.orders[0];
  const refusals: Array<[string, (o: OrderObservation) => void]> = [
    ['a total', o => { o.total = { currency: 'USD', amountMinor: 1100 }; }],
    ['a zero total', o => { o.total = { currency: 'USD', amountMinor: 0 }; }],
    ['items', o => { o.items = detailed().items; }],
    ['payment methods', o => { o.paymentMethods = detailed().paymentMethods; }],
    ['a summary', o => { o.summary = detailed().summary; }],
    ['a Refund Total', o => { o.refundSummary = { currency: 'USD', amountMinor: 100 }; }],
    ['a tender coverage', o => { o.tenderCoverage = 'multi-tender'; }],
    ['a tender proof flag', o => { o.tenderProof!.conflict = true; }],
    ['an item proof flag', o => { o.itemProof = { complete: false, unknownLine: true, conflict: false }; }],
    ['another status', o => { (o.chargeFree! as Record<string, unknown>).status = 'cancelled'; }],
    ['no shipments', o => { o.chargeFree!.shipments = 0; }],
    ['too many shipments', o => { o.chargeFree!.shipments = 101; }],
    ['a fractional count', o => { o.chargeFree!.shipments = 1.5; }],
    ['an extra key', o => { (o.chargeFree! as Record<string, unknown>).note = 'synthetic'; }],
  ];
  it.each(refusals)('refuses the proof with %s', async (_, mutate) => {
    const capture = proven();
    mutate(capture.staging.orders[0]);
    await expect(validateCapture(capture)).rejects.toThrow();
  });
});

let dir: string, repo: SqliteStateRepo, backupNumber: number, cardId: string;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const orderId = () => syntheticCapture().staging.orders[0].orderId;
const displayed = () => getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
const view = () => amazonSpending(db(), '2Y', '2026-10-19');
const count = (sql: string, ...args: unknown[]) => db().prepare(sql).pluck().get(...args) as number;
const subject = () => JSON.parse(db().prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck()
  .get(opaque('order-total', orderId())) as string) as { provenance: string; allocationComplete: boolean };
const row = () => db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get();
const audits = (action: string) => count('SELECT count(*) FROM amazon_audit WHERE action=?', action);
const linked = () => count(`SELECT (SELECT count(*) FROM amazon_matches WHERE state='linked')
  + (SELECT count(*) FROM amazon_ledger_matches WHERE state='linked')`);
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-charge-free-synthetic-')); backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
  cardId = card.id;
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: [600, 500].map((amountMinor, ordinal) => ({ transactionDate: '2026-09-03', status: 'posted',
      kind: 'purchase', currency: 'USD', amountMinor, description: `AMAZON SYNTHETIC ${ordinal}`, issuerCategory: 'Shopping' })) });
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('a positive no-charge proof supersedes earlier details', () => {
  it('counts a detailed-then-cancelled order 0 in the Amazon views and keeps its earlier items as history', async () => {
    await importAmazonCapture(db(), complete(1, []), backup());
    const before = view();
    expect([before.orders.withTotal, before.lines.count, before.totals[0].itemMinor]).toEqual([1, 2, 1000]);
    expect(subject().allocationComplete).toBe(true);
    const itemRows = count('SELECT count(*) FROM amazon_items');
    const receipt = await importAmazonCapture(db(), proven(), backup());
    expect(receipt.holds.some(h => h.reason === 'charge-free-contradicted')).toBe(false);
    const order = displayed();
    expect([order.items.length, order.total, order.itemObservations]).toEqual([0, null, 0]);
    const after = view();
    expect([after.orders.count, after.orders.withTotal, after.lines.count]).toEqual([1, 0, 0]);
    expect(after.totals.every(t => t.orderTotalMinor === 0 && t.itemMinor === 0 && t.netItemMinor === 0)).toBe(true);
    expect(after.products).toEqual([]);
    expect(count('SELECT count(*) FROM amazon_items')).toBe(itemRows);
    expect(count("SELECT count(*) FROM amazon_observations WHERE family='order'")).toBe(2);
    expect(audits('charge-free-superseded-details')).toBe(1);
    expect(subject()).toMatchObject({ provenance: 'unproven', allocationComplete: false });
    expect(count("SELECT count(*) FROM amazon_matches WHERE subject_ref=? AND state='linked'", opaque('order-total', orderId()))).toBe(0);
  });
  it.each([
    ['a witnessed header-only read', () => header(3)],
    ['an unwitnessed empty page', () => { const c = header(3); c.structure = syntheticCapture().structure; return c; }],
    ['an empty page without the proof and with no total', () => { const c = header(3); c.staging.orders[0].total = null; return c; }],
  ])('never lets %s replace details', async (_, poorer) => {
    await importAmazonCapture(db(), complete(), backup());
    const before = { row: row(), totals: view().totals };
    await importAmazonCapture(db(), poorer(), backup());
    expect(row()).toEqual(before.row);
    expect(view().totals).toEqual(before.totals);
    expect(audits('charge-free-superseded-details')).toBe(0);
  });
  it('keeps a displayed proof over a later poorer read and over stale details imported later', async () => {
    await importAmazonCapture(db(), complete(1, []), backup());
    await importAmazonCapture(db(), proven(), backup());
    const shown = row();
    for (const later of [header(6), complete(7, [])]) {
      await importAmazonCapture(db(), later, backup());
      expect(row()).toEqual(shown);
      expect(displayed().total).toBeNull();
      expect(view().orders.withTotal).toBe(0);
    }
    expect(audits('poorer-observation-kept-details')).toBe(2);
  });
  it('stores a proof directly for an order seen with no details yet', async () => {
    await importAmazonCapture(db(), proven(), backup());
    expect([displayed().items.length, displayed().total, view().orders.withTotal]).toEqual([0, null, 0]);
    expect(audits('charge-free-superseded-details')).toBe(0);
  });
});

describe("Root's guard: money evidence contradicts a no-charge proof, which then holds as a conflict", () => {
  const contradicted = async (receipt: Awaited<ReturnType<typeof importAmazonCapture>>, before: unknown) => {
    expect(row()).toEqual(before);
    expect(receipt.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(audits('charge-free-contradicted')).toBe(1);
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(audits('charge-free-superseded-details')).toBe(0);
  };
  it.each([
    ['a card charge linked to the order total', async () => {
      repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic', parserVersion: 'synthetic@1',
        rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
          description: 'AMAZON SYNTHETIC TOTAL', issuerCategory: 'Shopping' }] });
      await importAmazonCapture(db(), complete(1, []), backup());
      expect(count("SELECT count(*) FROM amazon_matches WHERE subject_ref=? AND state='linked'",
        opaque('order-total', orderId()))).toBe(1);
      return proven();
    }],
    ['an earlier ledger charge with no matching card', async () => {
      await importAmazonCapture(db(), complete(1, [777]), backup());
      expect(linked()).toBe(0);
      return proven();
    }],
    ['an earlier ledger charge linked to a card purchase', async () => {
      await importAmazonCapture(db(), complete(1, [600, 500]), backup());
      expect(count("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'")).toBeGreaterThan(0);
      return proven();
    }],
    ['a ledger charge in the proof capture itself', async () => {
      await importAmazonCapture(db(), complete(1, []), backup());
      return charged(proven(), [1100]);
    }],
  ])('%s: the displayed order, its spending and links hold', async (_, arrange) => {
    const proof = await arrange();
    const before = { row: row(), totals: view().totals, items: displayed().items.length, linked: linked() };
    const receipt = await importAmazonCapture(db(), proof, backup());
    await contradicted(receipt, before.row);
    expect(view().totals).toEqual(before.totals);
    expect(displayed().items.length).toBe(before.items);
    expect(displayed().total).not.toBeNull();
    expect(linked()).toBe(before.linked);
    // A later proof stays contradicted: the evidence does not expire.
    await importAmazonCapture(db(), proven(9), backup());
    expect(row()).toEqual(before.row);
    expect(audits('charge-free-contradicted')).toBe(2);
  });
  it('revokes a displayed proof when a charge for the order arrives later, restoring the pre-proof display', async () => {
    await importAmazonCapture(db(), complete(1, []), backup());
    const original = { row: row(), totals: view().totals };
    await importAmazonCapture(db(), proven(), backup());
    expect(view().totals.every(t => t.itemMinor === 0)).toBe(true);
    const receipt = await importAmazonCapture(db(), charged(header(6), [1100]), backup());
    expect(receipt.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(row()).toEqual(original.row);
    expect(view().totals).toEqual(original.totals);
    expect(subject()).toMatchObject({ provenance: 'order-total', allocationComplete: true });
    expect([audits('charge-free-revoked'), audits('charge-free-contradicted')]).toEqual([1, 0]);
    // Revocation is settled: a further import neither re-revokes nor re-displays a proof.
    await importAmazonCapture(db(), header(7), backup());
    await importAmazonCapture(db(), proven(8), backup());
    expect(row()).toEqual(original.row);
    expect([audits('charge-free-revoked'), audits('charge-free-contradicted')]).toEqual([1, 1]);
  });
  it('shows a contradicted proof for an order seen for the first time as an unread header, never as charge-free', async () => {
    const receipt = await importAmazonCapture(db(), charged(proven(), [1100]), backup());
    expect(receipt.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    const stored = JSON.parse((row() as { data_json: string }).data_json) as OrderObservation;
    expect([Object.hasOwn(stored, 'chargeFree'), stored.total, stored.items.length]).toEqual([false, null, 0]);
    expect(count("SELECT count(*) FROM amazon_observations WHERE family='order' AND json_extract(data_json,'$.chargeFree') IS NOT NULL")).toBe(1);
    // With no proof displayed, a later detailed read is an ordinary superset and replaces it.
    await importAmazonCapture(db(), complete(6, []), backup());
    expect([displayed().items.length, view().totals[0].itemMinor]).toEqual([2, 1000]);
  });
  // Live guard: an ordinary card import never reconciles Amazon, so persisted matches can lag the card ledger. The guard
  // reads the card evidence the resolver shows now.
  const purchases = (n: number) => repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic',
    parserVersion: 'synthetic@1', rows: Array.from({ length: n }, (_, i) => ({ transactionDate: '2026-09-02', status: 'posted',
      kind: 'purchase', currency: 'USD', amountMinor: 1100, description: `AMAZON SYNTHETIC LIVE ${i}`, issuerCategory: 'Shopping' })) });
  const live = () => createAmazonCategoryResolver(db()).snapshot().getOrderMatches(opaque('order', orderId()));
  it.each([
    [1, { state: 'linked' }],
    [2, { state: 'held', reason: 'ambiguous', candidateCount: 2 }],
  ])('%i card purchase(s) imported after the details, unreconciled, contradict a proof as the resolver links or matches them live',
    async (n, expected) => {
      await importAmazonCapture(db(), complete(1, []), backup());
      purchases(n);
      expect([count('SELECT count(*) FROM amazon_candidates'), linked()]).toEqual([0, 0]);
      expect(live()).toContainEqual(expect.objectContaining(expected));
      const before = { row: row(), totals: view().totals, live: live() };
      const receipt = await importAmazonCapture(db(), proven(), backup());
      await contradicted(receipt, before.row);
      expect(view().totals).toEqual(before.totals);
      expect(live()).toEqual(before.live);
      expect(view().totals[0].itemMinor).toBe(1000);
    });
  it('revokes a displayed proof at the next import once a card charge for its pre-proof display is imported', async () => {
    await importAmazonCapture(db(), complete(1, []), backup());
    const original = row();
    await importAmazonCapture(db(), proven(), backup());
    purchases(1);
    expect(live().some(m => m.state === 'linked')).toBe(false);
    const receipt = await importAmazonCapture(db(), header(6), backup());
    expect(receipt.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(row()).toEqual(original);
    expect([audits('charge-free-revoked'), audits('charge-free-contradicted')]).toEqual([1, 0]);
    expect(live()).toContainEqual(expect.objectContaining({ state: 'linked' }));
    expect(view().totals[0].itemMinor).toBe(1000);
  });
  it('revokes a displayed proof once its tipped pre-proof display\'s order charge (total minus tip) is imported', async () => {
    // The same details with a 200 tip (1300 in all), charged as 1300 - 200 = 1100 with the tip billed apart (tipSplit.ts).
    const tipped = complete(1, []), order = tipped.staging.orders[0];
    order.total = { currency: 'USD', amountMinor: 1300 };
    order.summary = [...order.summary!.filter(s => s.kind !== 'grand-total'), { kind: 'tip', money: { currency: 'USD', amountMinor: 200 } },
      { kind: 'grand-total', money: { currency: 'USD', amountMinor: 1300 } }];
    await importAmazonCapture(db(), tipped, backup());
    const original = row();
    await importAmazonCapture(db(), proven(), backup());
    purchases(1);
    expect(live().some(m => m.state === 'linked')).toBe(false);
    const receipt = await importAmazonCapture(db(), header(6), backup());
    expect(receipt.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(row()).toEqual(original);
    expect([audits('charge-free-revoked'), audits('charge-free-contradicted')]).toEqual([1, 0]);
    expect(live()).toContainEqual(expect.objectContaining({ state: 'linked' }));
  });
  it.each([
    ['the identical proof capture', () => proven()],
    ['the identical details capture', () => complete(1, [])],
  ])('an exact repeat of %s records nothing new but runs the same recheck, revoking and surfacing the proof', async (_, repeat) => {
    await importAmazonCapture(db(), complete(1, []), backup());
    const original = row();
    await importAmazonCapture(db(), proven(), backup());
    purchases(1);
    const observations = count('SELECT count(*) FROM amazon_observations');
    const receipt = await importAmazonCapture(db(), repeat(), backup());
    expect([receipt.newCaptures, receipt.newOrders, receipt.newObservations]).toEqual([0, 0, 0]);
    expect(count('SELECT count(*) FROM amazon_observations')).toBe(observations);
    expect(receipt.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(row()).toEqual(original);
    expect(audits('charge-free-revoked')).toBe(1);
    expect(live()).toContainEqual(expect.objectContaining({ state: 'linked' }));
    expect(view().totals[0].itemMinor).toBe(1000);
    // Settled: a further repeat has nothing left to revoke and reports no new contradiction.
    const again = await importAmazonCapture(db(), repeat(), backup());
    expect(again.holds.some(h => h.reason === 'charge-free-contradicted')).toBe(false);
    expect([row(), audits('charge-free-revoked')]).toEqual([original, 1]);
  });
  it('the reconcile command runs the same recheck first and reports the contradiction', async () => {
    await importAmazonCapture(db(), complete(1, []), backup());
    const original = row();
    await importAmazonCapture(db(), proven(), backup());
    purchases(1);
    const file = path.join(dir, 'synthetic.db'), go = path.join(dir, 'go-reconcile.json');
    fs.writeFileSync(go, JSON.stringify({ format: 'holdr.amazon-write-go', version: 2, authority: 'Root', decision: 'GO',
      purpose: 'copy-rehearsal', command: 'reconcile', databaseRef: digest(path.resolve(file)), inputDigest: digest(null),
      policyDigest: POLICY_DIGEST, schemaDigest: AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST }), { mode: 0o600 });
    let stdout = '', stderr = '';
    const code = await runAmazonCli(['reconcile', '--db', file, '--backup', path.join(dir, 'reconcile-before.db'), '--root-go', go],
      { env: { ...process.env, HOLDR_CONFIG: 'none' },
        io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } } });
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'reconciled', holds: [{ reason: 'charge-free-contradicted', count: 1 }] });
    expect(row()).toEqual(original);
    expect(audits('charge-free-revoked')).toBe(1);
    expect(live()).toContainEqual(expect.objectContaining({ state: 'linked' }));
  });
  it('lets an uncontradicted proof supersede when the bound card has no charge the order could match', async () => {
    repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-02', status: 'pending', kind: 'purchase', currency: 'USD', amountMinor: 1100,
        description: 'AMAZON SYNTHETIC PENDING', issuerCategory: 'Shopping' }] });
    await importAmazonCapture(db(), complete(1, []), backup());
    const receipt = await importAmazonCapture(db(), proven(), backup());
    expect(receipt.holds.some(h => h.reason === 'charge-free-contradicted')).toBe(false);
    expect([displayed().total, audits('charge-free-superseded-details')]).toEqual([null, 1]);
  });
});
