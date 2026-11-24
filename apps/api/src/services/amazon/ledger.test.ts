import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardSyncActorRef } from '../cardSyncDigests.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { rootApproval, syntheticCapture, syntheticRow, syntheticSubject, syntheticCards } from './fixtures.testSupport.js';
import { matchAmazon, readLedger, readSubjects } from './matcher.js';
import { createAmazonCategoryResolver, AMAZON_ITEMIZATION_REASONS } from './resolver.js';
import { amazonSummary } from './readModel.js';
import { digest, LEDGER_POLICY_DIGEST, opaque, POLICY_DIGEST } from './policy.js';
import type { MatchSubject, PaymentObservation, Staging } from './types.js';

let dir: string, repo: SqliteStateRepo, number: number, cardId: string;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++number}.db`);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-ledger-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') }); number = 0;
  cardId = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' }).id;
  const cards = readCardInventory(db());
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: cardId }], cards);
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
function rows(amounts: number[], date = '2026-09-03', description = 'AMAZON SYNTHETIC RETAIL') {
  repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: amounts.map((amountMinor, ordinal) => ({ transactionDate: date, status: 'posted' as const,
      kind: amountMinor > 0 ? 'purchase' as const : 'refund' as const, amountMinor, currency: 'USD',
      description: `${description} ${ordinal}`, issuerCategory: 'Shopping' })) });
}
function capture(amounts: number[], run = 1) {
  const c = syntheticCapture();
  c.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  const o = c.staging.orders[0];
  o.itemProof = { complete: true, unknownLine: false, conflict: false };
  o.items[0].unitPrice!.amountMinor = 500;
  o.items.push({ ...structuredClone(o.items[0]), lineOrdinal: 1, title: 'Synthetic second widget' });
  c.staging.payments = amounts.map((amount, ordinal): PaymentObservation => ({
    date: '2026-09-03', money: { currency: 'USD', amountMinor: amount }, kind: amount > 0 ? 'charge' : 'refund',
    status: 'completed', method: { kind: 'card', network: 'visa', last4: '9001' },
    orderIds: [o.orderId], identity: 'native-row',
    provenance: { source: 'ledger', status: amount > 0 ? 'Charged' : 'Refunded', page: 0, ordinal },
  }));
  coverage(c.staging);
  return c;
}
function coverage(s: Staging) {
  const n = s.payments.length, refunds = s.payments.filter(p => p.kind === 'refund').length;
  s.coverage.details.records = s.orders.reduce((n, o) => n + o.items.length, 0);
  s.coverage.payments = { status: n ? 'partial' : 'held', reason: 'budget', pages: 1, records: n, rejected: 0 };
  s.coverage.refunds = { status: refunds ? 'partial' : 'held', reason: 'budget', pages: 1, records: refunds, rejected: 0 };
}
async function categorize() {
  await backedUpWrite(db(), backup(), () => {
    for (const ref of db().prepare('SELECT ref FROM amazon_items').pluck().all() as string[]) {
      db().prepare('INSERT OR REPLACE INTO amazon_item_overrides VALUES(?,?)').run(ref, 'Synthetic Household');
    }
  });
}
const snapshot = () => createAmazonCategoryResolver(db()).snapshot();
const resolved = () => snapshot().resolve(readLedger(db()));
function ledgerSubject(patch: Partial<MatchSubject> = {}): MatchSubject {
  return syntheticSubject({ evidenceClass: 'payment-ledger-complete', nativeOccurrenceId: null,
    ledgerObservation: { captureDigest: digest('synthetic'), runId: 'synthetic-run', page: 0, ordinal: 0 }, ...patch });
}

describe('ledger card anchors and complete order allocation', () => {
  // STEP 9 integration (revocation)
  it('backs up the original 22-table schema before adding exactly the six later tables and preserves legacy rows', async () => {
    db().exec(`DROP TABLE amazon_ledger_matches; DROP TABLE amazon_ledger_candidates; DROP TABLE amazon_capture_runs;
      DROP TABLE amazon_refund_event_members; DROP TABLE amazon_refund_events; DROP TABLE amazon_proof_predecessors`);
    const before = db().prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%'").pluck().get();
    expect(before).toBe(22);
    const file = backup();
    await importAmazonCapture(db(), capture([600, 500]), file);
    const saved = new Database(file, { readonly: true });
    try {
      expect(saved.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%'").pluck().get()).toBe(22);
      expect(saved.prepare('SELECT * FROM amazon_binding_approvals').all()).toEqual(db().prepare('SELECT * FROM amazon_binding_approvals').all());
    } finally { saved.close(); }
    // STEP 9 integration (revocation)
    expect(db().prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%'").pluck().get()).toBe(28);
  });
  it('itemizes two shipment card rows with exact row AND order-item column margins, never changing the ledger', async () => {
    rows([600, 500]);
    const before = JSON.stringify(readLedger(db()));
    await importAmazonCapture(db(), capture([600, 500]), backup()); await categorize();
    const answer = [...resolved().values()];
    expect(answer).toHaveLength(2);
    const perItem = new Map<string, number>();
    for (const r of answer) {
      expect(r.kind).toBe('split');
      if (r.kind !== 'split') throw Error('synthetic split expected');
      expect(r.evidenceClass).toBe('payment-ledger-complete');
      expect(r.contributions.every(p => p.classification === 'policy-allocated')).toBe(true);
      const row = readLedger(db()).find(row => row.id === r.cardTransactionId)!;
      expect(r.contributions.reduce((n, p) => n + p.amountMinor, 0)).toBe(row.amountMinor);
      for (const p of r.contributions) perItem.set(p.itemRef!, (perItem.get(p.itemRef!) ?? 0) + p.amountMinor);
    }
    expect([...perItem.values()].sort()).toEqual([550, 550]);
    expect(JSON.stringify(readLedger(db()))).toBe(before);
    expect(snapshot().matchCounts).toMatchObject({ itemizedRows: 2, itemParts: 4, itemizableRows: 2 });
    expect(amazonSummary(db())).toMatchObject({ itemizedRows: 2, itemParts: 4 });
    expect(snapshot().matchCounts.heldByReason.map(r => r.reason)).toEqual(AMAZON_ITEMIZATION_REASONS);
    expect(snapshot().matchCounts.splitRowsByEvidence).toContainEqual({ evidenceClass: 'payment-ledger-complete', count: 2 });
    expect(snapshot().isAmazonCharge(readLedger(db())[0].id)).toBe(true);
    expect(db().prepare("SELECT policy_digest FROM amazon_audit WHERE action='reconcile' AND subject_ref IN (SELECT ref FROM amazon_observations WHERE family='payment')")
      .pluck().all()).toEqual([LEDGER_POLICY_DIGEST, LEDGER_POLICY_DIGEST]);
    expect(db().prepare('SELECT data_json FROM amazon_binding_approvals').pluck().all().map(t => JSON.parse(String(t)).policyDigest))
      .toEqual([POLICY_DIGEST]);
  });
  it('unions an order split across runs, retains observations on later partial runs, and adds zero on exact repeat', async () => {
    rows([600, 500]);
    const first = capture([600], 1), second = capture([500], 2);
    await importAmazonCapture(db(), first, backup()); await categorize();
    expect([...resolved().values()].every(r => r.kind === 'whole-row')).toBe(true);
    await importAmazonCapture(db(), second, backup()); await categorize();
    expect([...resolved().values()].filter(r => r.kind === 'split')).toHaveLength(2);
    const before = db().prepare('SELECT count(*) FROM amazon_audit').pluck().get();
    expect(await importAmazonCapture(db(), second, backup())).toMatchObject({
      newCaptures: 0, newOrders: 0, newObservations: 0, newMatches: 0, invalidated: 0,
    });
    expect(db().prepare('SELECT count(*) FROM amazon_audit').pluck().get()).toBe(before);
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE family='payment'").pluck().get()).toBe(2);
    const oldRepeat = await importAmazonCapture(db(), first, backup());
    expect(oldRepeat).toMatchObject({ newCaptures: 0, newMatches: 0 });
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
  });
  it('corroborates the same uniquely anchored card charge in two runs without economic IDs or extra matches', async () => {
    rows([600, 500]);
    await importAmazonCapture(db(), capture([600, 500], 1), backup());
    const delta = await importAmazonCapture(db(), capture([600], 2), backup()); await categorize();
    expect(delta).toMatchObject({ newCaptures: 1, newOrders: 0, newObservations: 4, newMatches: 0 });
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
    const ledger = readSubjects(db()).filter(s => s.evidenceClass === 'payment-ledger-complete');
    expect(ledger).toHaveLength(3);
    expect(ledger.every(s => s.nativeOccurrenceId === null)).toBe(true);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'").pluck().get()).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE json_extract(data_json,'$.reason')='corroborated'").pluck().get()).toBe(1);
  });
  it('retains successful observations when an explicitly re-armed partial page repeats them at a new run/page/ordinal', async () => {
    rows([600, 500]);
    await importAmazonCapture(db(), capture([600, 500], 1), backup());
    const rearmed = capture([600, 500], 2);
    rearmed.staging.payments.forEach((payment, index) => {
      payment.provenance!.page = 1;
      payment.provenance!.ordinal = 10 + index;
    });
    rearmed.staging.coverage.payments.pages = 2;
    const delta = await importAmazonCapture(db(), rearmed, backup()); await categorize();
    expect(delta.newMatches).toBe(0);
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_observations WHERE family='payment'").pluck().get()).toBe(4);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'").pluck().get()).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE json_extract(data_json,'$.reason')='corroborated'").pluck().get()).toBe(2);
    expect([...resolved().values()].flatMap(r => r.kind === 'split' ? r.contributions : [])
      .reduce((sum, part) => sum + part.amountMinor, 0)).toBe(1100);
  });
  it('does not activate old observations on read before run metadata is registered by an exact authorized reimport', async () => {
    rows([600, 500]);
    const c = capture([600, 500]);
    await importAmazonCapture(db(), c, backup()); await categorize();
    db().prepare('DELETE FROM amazon_capture_runs').run();
    const before = db().prepare('SELECT total_changes()').pluck().get();
    expect(snapshot().matchCounts.itemizedRows).toBe(0);
    expect(snapshot().matchCounts.ledgerObservationsByReason).toContainEqual({ reason: 'evidence-held', count: 2 });
    expect(db().prepare('SELECT total_changes()').pluck().get()).toBe(before);
    expect(await importAmazonCapture(db(), c, backup())).toMatchObject({ newCaptures: 0, newOrders: 0, newObservations: 0 });
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
  });
  it('holds two identical charge occurrences in one run, and invalidates earlier itemization after a competing card backfill', async () => {
    rows([600, 500]);
    await importAmazonCapture(db(), capture([600, 500, 600]), backup()); await categorize();
    expect([...resolved().values()].every(r => r.kind === 'whole-row')).toBe(true);
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'").pluck().get()).toBe(1);
    const separate = capture([600, 500], 2);
    await importAmazonCapture(db(), separate, backup());
    expect(snapshot().matchCounts.itemizedRows).toBe(0);
  });
  it('withdraws cached enrichment when a competing posted card row arrives without writing snapshot state', async () => {
    rows([600, 500]); await importAmazonCapture(db(), capture([600, 500]), backup()); await categorize();
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
    const old = snapshot().version;
    rows([600], '2026-09-04');
    const before = db().prepare('SELECT total_changes()').pluck().get();
    expect(snapshot().version).not.toBe(old);
    expect(snapshot().matchCounts.itemizedRows).toBe(0);
    expect(db().prepare('SELECT total_changes()').pluck().get()).toBe(before);
  });
  it.each(['gift-card', 'rewards'] as const)('allows a positively known %s share, never assumes missing charges are non-card', async kind => {
    rows([600]);
    const c = capture([600]);
    c.staging.orders[0].tenderCoverage = 'multi-tender';
    c.staging.orders[0].summary!.push({ kind, money: { currency: 'USD', amountMinor: -500 } });
    await importAmazonCapture(db(), c, backup()); await categorize();
    expect([...resolved().values()][0]).toMatchObject({ kind: 'split', evidenceClass: 'payment-ledger-complete' });
    expect([...resolved().values()][0].kind === 'split' && snapshot().matchCounts.itemizedRows).toBe(1);
  });
  it('holds an incomplete charge sum, null item proof, unknown summary, and conflicting prior complete observations', async () => {
    rows([600]);
    const c = capture([600]);
    await importAmazonCapture(db(), c, backup()); await categorize();
    expect([...resolved().values()][0]).toMatchObject({ kind: 'whole-row', reason: 'mixed-tender-unproven' });
    const newer = capture([600], 2);
    newer.staging.orders[0].items[0].title = 'Synthetic contradictory complete line';
    await importAmazonCapture(db(), newer, backup()); await categorize();
    expect([...resolved().values()][0]).toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
  });
  it('keeps existing unique-total precedence with no double counting', async () => {
    rows([1100]); await importAmazonCapture(db(), capture([1100]), backup()); await categorize();
    expect(snapshot().matchCounts).toMatchObject({ linked: 1, itemizedRows: 1 });
    expect([...resolved().values()][0]).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    expect(db().prepare("SELECT count(*) FROM amazon_ledger_matches WHERE state='linked'").pluck().get()).toBe(0);
  });
  it('does not allocate an additional order-total row when distinct ledger anchors already cover that order', async () => {
    rows([600, 500, 1100]);
    await importAmazonCapture(db(), capture([600, 500]), backup()); await categorize();
    const answer = resolved();
    const totalRow = readLedger(db()).find(r => r.amountMinor === 1100)!;
    expect(answer.get(totalRow.id)).toMatchObject({ kind: 'whole-row', reason: 'match-held' });
    const parts = [...answer.values()].flatMap(r => r.kind === 'split' ? r.contributions : []);
    expect(parts.reduce((n, p) => n + p.amountMinor, 0)).toBe(1100);
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_matches WHERE state='linked'").pluck().get()).toBe(0);
  });
  it('invalidates a previously allocated fallback on a distinct row when ledger evidence for the same order arrives', async () => {
    rows([1100, 600]);
    const first = capture([], 1);
    await importAmazonCapture(db(), first, backup()); await categorize();
    expect(snapshot().matchCounts.itemizedRows).toBe(1);
    const result = await importAmazonCapture(db(), capture([600], 2), backup()); await categorize();
    expect(result.invalidated).toBe(1);
    expect(snapshot().matchCounts.itemizedRows).toBe(0);
    expect([...resolved().values()].every(r => r.kind === 'whole-row')).toBe(true);
  });
  it('holds allocation when ledger card methods contradict the positively complete order method block', async () => {
    rows([600, 500]);
    const c = capture([600, 500]);
    c.staging.orders[0].paymentMethods![0].last4 = '9002';
    await importAmazonCapture(db(), c, backup()); await categorize();
    expect([...resolved().values()].every(r => r.kind === 'whole-row' && r.reason === 'inconsistent-evidence')).toBe(true);
    expect(snapshot().matchCounts.itemizedRows).toBe(0);
  });
  it('allows two explicitly observed bound cards without confusing payer and beneficiary', async () => {
    const marriott = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD' });
    const cards = readCardInventory(db());
    const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    rows([600]);
    repo.importCardTransactions({ cardAccountId: marriott.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      { transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', amountMinor: 500, currency: 'USD',
        description: 'AMAZON SYNTHETIC OTHER CARD', issuerCategory: 'Shopping' },
    ] });
    const c = capture([600, 500]);
    c.staging.orders[0].tenderCoverage = 'multi-tender';
    c.staging.orders[0].paymentMethods!.push({ kind: 'card', network: 'visa', last4: '9002' });
    c.staging.payments[1].method.last4 = '9002';
    await importAmazonCapture(db(), c, backup()); await categorize();
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
    expect([...resolved().values()].every(r => r.kind === 'split')).toBe(true);
    expect(db().prepare('SELECT beneficiary FROM amazon_orders').pluck().get()).toBeNull();
  });
  it('mirrors itemized charges on a full ledger refund; keeps a refund its charges cannot explain whole', async () => {
    // The ledger link is final, but with no charge of the order on the card ledger nothing says what it refunds.
    rows([-1100]);
    await importAmazonCapture(db(), capture([-1100]), backup()); await categorize();
    const full = readLedger(db()).find(r => r.amountMinor === -1100)!;
    expect(resolved().get(full.id)).toMatchObject({ kind: 'whole-row', reason: 'refund-unattributed' });
    expect(snapshot().getCardDetail(full.id)).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete' });
    // The order's two charges arrive and are itemized: the full refund files exactly the opposite of their item parts.
    rows([600, 500]);
    await importAmazonCapture(db(), capture([600, 500], 2), backup()); await categorize();
    const charges = [...resolved()].filter(([id]) => id !== full.id);
    expect(resolved().get(full.id)).toMatchObject({ kind: 'split', evidenceClass: 'payment-ledger-complete' });
    const perItem = new Map<string, number>();
    for (const r of resolved().values()) if (r.kind === 'split') {
      for (const p of r.contributions) perItem.set(p.itemRef!, (perItem.get(p.itemRef!) ?? 0) + p.amountMinor);
    }
    expect([...perItem.values()]).toEqual([0, 0]);
    expect(snapshot().getCardDetail(full.id).parts!.every(p => p.amountMinor < 0 && p.classification === 'policy-allocated')).toBe(true);
    // A partial refund on top would refund more than the charges paid: both refunds stay whole, the charges split.
    rows([-200]);
    await importAmazonCapture(db(), capture([-200], 3), backup()); await categorize();
    const after = resolved();
    for (const r of readLedger(db()).filter(r => r.amountMinor < 0)) {
      expect(after.get(r.id)).toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
    }
    // Item refs are capture-scoped, so compare what each charge files: the same categories and amounts.
    const filed = (id: string) => { const r = after.get(id); return r?.kind === 'split' ? r.contributions.map(p => [p.category, p.amountMinor]) : r; };
    expect(charges.map(([id]) => filed(id))).toEqual(charges.map(([, r]) => r.kind === 'split' ? r.contributions.map(p => [p.category, p.amountMinor]) : r));
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
  });
  it('files a partial ledger refund under the line it paid back, on the observation the ledger allocation used', async () => {
    rows([600, 500]); rows([-660], '2026-09-10');
    const c = capture([600, 500, -660]);
    c.staging.orders[0].items[0].unitPrice!.amountMinor = 600;
    c.staging.orders[0].items[1].unitPrice!.amountMinor = 400;
    await importAmazonCapture(db(), c, backup()); await categorize();
    const [captureDigest] = db().prepare('SELECT digest FROM amazon_captures').pluck().all() as string[];
    const line = (n: number) => opaque('line-observation', [captureDigest, c.staging.orders[0].orderId, n]);
    const refund = readLedger(db()).find(r => r.amountMinor === -660)!, answer = resolved();
    // 660 is the first line's price and its tax share; the two ledger charges filed 660 and 440 under the lines.
    expect(answer.get(refund.id)).toEqual({ kind: 'split', cardTransactionId: refund.id, currency: 'USD', evidenceClass: 'payment-ledger-complete',
      contributions: [{ itemRef: line(0), amountMinor: -660, category: 'Synthetic Household', categorySource: 'item-override',
        classification: 'policy-allocated' }] });
    const perItem = new Map<string, number>();
    for (const r of answer.values()) if (r.kind === 'split') {
      for (const p of r.contributions) perItem.set(p.itemRef!, (perItem.get(p.itemRef!) ?? 0) + p.amountMinor);
    }
    expect(perItem).toEqual(new Map([[line(0), 0], [line(1), 440]]));
    expect(snapshot().matchCounts).toMatchObject({ itemizedRows: 2, refundCredits: { ledgerLinked: 1, itemized: 1 } });
  });
  it('keeps a partial ledger refund of a split-tender order whole: one refund payment may be one tender\'s share', async () => {
    const other = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD' });
    const cards = readCardInventory(db());
    const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    rows([600]); rows([-660], '2026-09-10');
    repo.importCardTransactions({ cardAccountId: other.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      { transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', amountMinor: 500, currency: 'USD',
        description: 'AMAZON SYNTHETIC OTHER CARD', issuerCategory: 'Shopping' },
    ] });
    const c = capture([600, 500, -660]);
    c.staging.orders[0].items[0].unitPrice!.amountMinor = 600;
    c.staging.orders[0].items[1].unitPrice!.amountMinor = 400;
    c.staging.orders[0].tenderCoverage = 'multi-tender';
    c.staging.orders[0].paymentMethods!.push({ kind: 'card', network: 'visa', last4: '9002' });
    c.staging.payments[1].method.last4 = '9002';
    await importAmazonCapture(db(), c, backup()); await categorize();
    expect(snapshot().matchCounts.itemizedRows).toBe(2);
    const refund = readLedger(db()).find(r => r.amountMinor === -660)!;
    expect(snapshot().getCardDetail(refund.id)).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete' });
    expect(resolved().get(refund.id)).toEqual({ kind: 'whole-row', cardTransactionId: refund.id, reason: 'refund-unattributed' });
  });
  it('user category keeps the card row whole for itemized KPI, and cohort excludes closed digital/AWS descriptors', async () => {
    rows([600, 500]); await importAmazonCapture(db(), capture([600, 500]), backup()); await categorize();
    const id = readLedger(db())[0].id;
    repo.updateCardTransaction(id, { userCategory: 'Synthetic custom' }, { actorRef: cardSyncActorRef('synthetic-owner') });
    rows([100], '2026-09-04', 'AMZN DIGITAL');
    rows([101], '2026-09-04', 'AMAZON WEB SERVICES');
    const s = snapshot();
    expect(s.matchCounts).toMatchObject({ cohortRows: 3, notItemizableRows: 1, itemizableRows: 2, itemizedRows: 1 });
    expect(s.matchCounts.heldByReason).toContainEqual({ reason: 'user-category', count: 1 });
  });
  it('counts tips, Prime fees and Amazon Pay apart as not itemizable, never in the itemizable cohort or no-evidence', () => {
    // Synthetic descriptors, references and merchant only.
    const posted = (description: string, amountMinor: number) => ({ transactionDate: '2026-09-03', status: 'posted' as const,
      kind: 'purchase' as const, amountMinor, currency: 'USD', description, issuerCategory: 'Shopping' });
    const add = (...list: Array<ReturnType<typeof posted>>) =>
      repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic', parserVersion: 'synthetic@1', rows: list });
    const idOf = (description: string) => readLedger(db()).find(row => row.description === description)!.id;
    add(posted('AMAZON GROCE*SYNTH01', 101), posted('AMAZON MARK*SYNTH02 AMZN.COM/BILL WA', 102),
      posted('AMZN Mktp US*SYNTH03', 103), posted('Amazon.com*SYNTH04', 104));
    const before = snapshot().matchCounts;
    expect(before).toMatchObject({ amazonRows: 4, cohortRows: 4, notItemizableRows: 0, itemizableRows: 4 });
    expect(before.heldByReason).toContainEqual({ reason: 'no-evidence', count: 4 });
    const never = ['AMAZON TIPS*SYNTH05', 'AMAZON TIPS*SYNTH06', 'AMAZON PRIME*SYNTH07', 'AMZ*SYNTH08 FABRIKAM SAMPLE AMZN.COM/BILL WA'];
    // A bare AMZ* descriptor names no Amazon word: not an Amazon row, as before.
    add(...never.map((description, ordinal) => posted(description, 201 + ordinal)), posted('AMZ*SYNTH09 FABRIKAM SAMPLE', 205));
    const after = snapshot();
    // Each still counted, once, under not-itemizable: the itemizable cohort and its no-evidence group do not grow.
    expect(after.matchCounts).toMatchObject({ amazonRows: 8, cohortRows: 8, notItemizableRows: 4, itemizableRows: 4 });
    expect(after.matchCounts.heldByReason).toContainEqual({ reason: 'no-evidence', count: 4 });
    expect(after.matchCounts.excludedRows).toContainEqual({ reason: 'not-itemizable', count: 4 });
    for (const description of never) expect(after.isAmazonCharge(idOf(description)), description).toBe(false);
    expect(after.isAmazonCharge(idOf('AMAZON GROCE*SYNTH01'))).toBe(true);
  });
  it.each(['missing-items', 'unknown-summary', 'missing-shipping', 'unknown-method', 'wrong-noncard'] as const)(
    'does not allocate when %s defeats positive completeness', async failure => {
      rows([600, 500]);
      const c = capture([600, 500]), o = c.staging.orders[0];
      o.tenderCoverage = 'unknown';
      if (failure === 'missing-items') delete o.itemProof;
      if (failure === 'unknown-summary') o.tenderProof!.unknownSummary = true;
      if (failure === 'missing-shipping') o.summary = o.summary!.filter(s => s.kind !== 'shipping');
      if (failure === 'unknown-method') o.tenderProof!.unknownMethod = true;
      if (failure === 'wrong-noncard') o.summary!.push({ kind: 'gift-card', money: { currency: 'USD', amountMinor: -1 } });
      await importAmazonCapture(db(), c, backup()); await categorize();
      expect([...resolved().values()].every(r => r.kind === 'whole-row')).toBe(true);
      expect(snapshot().matchCounts.itemizedRows).toBe(0);
    },
  );
  it('balances rounding ties across item columns, independent of the order charges are imported', async () => {
    rows([1], '2026-09-01'); rows([1], '2026-09-20');
    const c = capture([1, 1]), o = c.staging.orders[0];
    o.total!.amountMinor = 2; o.items.forEach(i => { i.unitPrice!.amountMinor = 1; });
    o.summary!.forEach(s => { s.money.amountMinor = ['items-subtotal', 'grand-total'].includes(s.kind) ? 2 : 0; });
    c.staging.payments[0].date = '2026-09-01'; c.staging.payments[1].date = '2026-09-20';
    await importAmazonCapture(db(), c, backup()); await categorize();
    const splits = [...resolved().values()];
    expect(splits).toHaveLength(2);
    const itemRefs: string[] = [];
    for (const s of splits) {
      expect(s.kind).toBe('split');
      if (s.kind === 'split') {
        expect(s.contributions.map(p => p.amountMinor)).toEqual([1]);
        itemRefs.push(s.contributions[0].itemRef!);
      }
    }
    expect(new Set(itemRefs).size).toBe(2);
  });
  it('normalizes positive displayed Refunded money only from validated status and keeps refund-summary out of events', async () => {
    rows([600, 500, -1100]);
    const c = capture([600, 500, -1100]); c.staging.payments[2].money.amountMinor = 1100;
    await importAmazonCapture(db(), c, backup()); await categorize();
    const refund = readLedger(db()).find(r => r.amountMinor === -1100)!;
    expect(resolved().get(refund.id)).toMatchObject({ kind: 'split', evidenceClass: 'payment-ledger-complete' });
    expect(snapshot().matchCounts.excludedRows).toContainEqual({ reason: 'refund', count: 1 });
  });
  it('retains every excluded cohort row in a separate closed bucket and leaves frozen counts immutable', async () => {
    repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic', parserVersion: 'synthetic@2', rows: [
      { transactionDate: '2026-09-02', status: 'pending', kind: 'purchase', amountMinor: 5, currency: 'USD', description: 'AMZN SYNTHETIC PENDING' },
      { transactionDate: '2026-09-02', status: 'posted', kind: 'refund', amountMinor: -6, currency: 'USD', description: 'AMZN SYNTHETIC REFUND' },
      { transactionDate: '2026-09-02', status: 'posted', kind: 'fee', amountMinor: 7, currency: 'USD', description: 'AMZN SYNTHETIC FEE' },
    ] });
    const euro = repo.createCardAccount({ issuer: 'citi', owner: 'alex', currency: 'EUR' });
    repo.importCardTransactions({ cardAccountId: euro.id, source: 'synthetic', parserVersion: 'synthetic@2', rows: [
      { transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 8, currency: 'EUR', description: 'AMZN SYNTHETIC EUR' },
    ] });
    const counts = snapshot().matchCounts;
    expect(counts).toMatchObject({ amazonRows: 4, cohortRows: 0, itemizableRows: 0, nonUsdRows: 1 });
    expect(counts.excludedRows.filter(r => r.count).map(r => [r.reason, r.count]))
      .toEqual([['pending', 1], ['refund', 1], ['other-currency', 1], ['other-kind', 1]]);
    expect(Object.isFrozen(counts)).toBe(true);
    expect(Object.isFrozen(counts.excludedRows)).toBe(true);
    expect(Object.isFrozen(counts.excludedRows[0])).toBe(true);
  });
});

describe('ledger candidate boundaries', () => {
  const bindings = [{ network: 'visa' as const, last4: '9001', cardAccountId: syntheticCards[0].id }];
  it.each(['2026-08-29', '2026-09-08'])('admits inclusive ledger date edge %s', date => {
    expect(matchAmazon([ledgerSubject()], [syntheticRow({ transactionDate: date })], bindings).results[0].state).toBe('linked');
  });

  describe('pre-migration snapshot version', () => {
    it('pins fallback ledger classification and KPI facts even without any Amazon schema', () => {
      const memory = new Database(':memory:');
      try {
        memory.exec(`CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
          user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);
          INSERT INTO card_transactions VALUES('synthetic-row','synthetic-card','2026-09-03','posted','purchase','USD',
            100,NULL,'Shopping',NULL,NULL,NULL,'SYNTHETIC SHOP')`);
        const resolver = createAmazonCategoryResolver(memory), before = resolver.snapshot();
        expect(before.isAmazonCharge('synthetic-row')).toBe(false);
        memory.prepare("UPDATE card_transactions SET description='AMAZON SYNTHETIC'").run();
        const after = resolver.snapshot();
        expect(after.version).not.toBe(before.version);
        expect(after.isAmazonCharge('synthetic-row')).toBe(true);
        expect(after.matchCounts.cohortRows).toBe(1);
        expect(before.matchCounts.cohortRows).toBe(0);
      } finally { memory.close(); }
    });
  });
  it.each(['2026-08-28', '2026-09-09'])('holds beyond ledger date edge %s', date => {
    expect(matchAmazon([ledgerSubject()], [syntheticRow({ transactionDate: date })], bindings).results[0].state).toBe('held');
  });
  it('holds competing rows, cross-run conflicting dates, multi-order, pending, missing bindings and wrong currency', () => {
    const s = ledgerSubject(), row = syntheticRow();
    expect(matchAmazon([s], [row, { ...row, id: 'other' }], bindings).results[0].reason).toBe('ambiguous');
    const other = ledgerSubject({ ref: opaque('obs', 'two'), date: '2026-09-02',
      ledgerObservation: { captureDigest: digest('other'), runId: 'other-run', page: 0, ordinal: 0 } });
    expect(matchAmazon([s, other], [row], bindings).results.every(r => r.reason === 'ambiguous')).toBe(true);
    expect(matchAmazon([{ ...s, evidenceHoldReason: 'multiple-orders', orderRefs: [...s.orderRefs, opaque('order', 'two')] }],
      [row], bindings).results[0].reason).toBe('multiple-orders');
    expect(matchAmazon([{ ...s, status: 'pending' }], [row], bindings).results[0].state).toBe('held');
    expect(matchAmazon([s], [row], []).results[0].reason).toBe('binding-held');
    expect(matchAmazon([s], [{ ...row, currency: 'EUR' }], bindings).results[0].state).toBe('held');
  });
  it('refuses conflicting payloads for the same occurrence even when they would otherwise match different card rows', () => {
    const one = ledgerSubject(), two = ledgerSubject({ ref: opaque('obs', 'conflict'), money: { currency: 'USD', amountMinor: 900 } });
    expect(matchAmazon([one, two], [syntheticRow(), syntheticRow({ id: 'other', amountMinor: 900 })], bindings)
      .results.every(r => r.state === 'held' && r.reason === 'evidence-held')).toBe(true);
  });
  it('keeps multi-order candidates as competing claims and never lets them establish order completeness', () => {
    const one = ledgerSubject(), two = ledgerSubject({ ref: opaque('obs', 'multi'), evidenceHoldReason: 'multiple-orders',
      orderRefs: [...one.orderRefs, opaque('order', 'other')],
      ledgerObservation: { captureDigest: digest('two'), runId: 'two', page: 0, ordinal: 0 } });
    const result = matchAmazon([one, two], [syntheticRow()], bindings);
    expect(result.results.every(r => r.state === 'held')).toBe(true);
    expect(result.results.map(r => r.reason)).toEqual(['ambiguous', 'multiple-orders']);
  });
});
