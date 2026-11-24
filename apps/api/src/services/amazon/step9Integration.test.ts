import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, compareObservation, displayDecision, importAmazonCapture, recordBindingProposal, recordRootApproval,
  revokeContradictedProofs } from './importer.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { rootApproval, syntheticCapture, syntheticEvidence, withRefundEvidence } from './fixtures.testSupport.js';
import { opaque } from './policy.js';
import { productKey } from './products.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { listRefundEvents } from './refundEvents.js';
import { installAmazonTaxonomySchema, readTaxonomyAssignments } from './taxonomy.js';
import type { OrderObservation, RefundEvidence } from './types.js';

// STEP 9 integration regressions. #158's display rule (displayDecision) carries #168's facts from outside the order
// (statusRegressed, categoriesUnmatched) into compareObservation at every import. A revocation is a card-side event, not a
// read (Root): it restores exactly the display its proof displaced, recorded with the proof, and only the next real read
// advances it. Synthetic data only.
const detailed = (run: number, change: (o: OrderObservation) => void = () => undefined) => {
  const capture = syntheticCapture(), o = capture.staging.orders[0];
  capture.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  o.itemProof = { complete: true, unknownLine: false, conflict: false };
  change(o);
  capture.staging.coverage.details.records = o.items.length;
  return capture;
};
// Amazon's closed positive statement that the order was cancelled and never charged, read as an empty header.
const proven = (run: number) => {
  const capture = detailed(run), o = capture.staging.orders[0];
  o.items = []; o.paymentMethods = []; o.summary = []; o.tenderCoverage = 'unknown'; o.total = null;
  delete o.itemProof;
  o.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false };
  o.chargeFree = { status: 'cancelled-not-charged', shipments: 1 };
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
};
const refund = (amountMinor: number) => (o: OrderObservation) => { o.refundSummary = { currency: 'USD', amountMinor }; };
// The order-details refund statement for the synthetic order's line: issued (completed, with money) or taken back (pending).
const stated = (status: 'completed' | 'pending') => status === 'completed'
  ? syntheticEvidence({ money: { currency: 'USD', amountMinor: 500 } })
  : syntheticEvidence({ status: 'pending', money: null, date: null,
    provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-pending' } } as Partial<RefundEvidence>);

let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const row = () => db().prepare('SELECT latest_digest,data_json FROM amazon_orders').get() as { latest_digest: string; data_json: string };
const displayedObservation = () => JSON.parse(row().data_json) as OrderObservation;
const shownOrder = () => getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!;
const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action) as number;
const decide = (categories: string[]) => backedUpWrite(db(), backup(), () => {
  const items = shownOrder().items;
  categories.forEach((category, n) => db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(items[n].ref, category));
});
const NOW = '2026-10-19T12:00:00.000Z';
// A card the owner bound to the synthetic order's visa ending, with no charge yet; a later charge of the order's total is
// card evidence the live guard finds for the display a proof replaced.
const bindCard = async () => {
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
  return card.id;
};
const chargeCard = (cardAccountId: string) => repo.importCardTransactions({ cardAccountId, source: 'synthetic',
  parserVersion: 'synthetic@1', rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD',
    amountMinor: 1100, description: 'AMAZON SYNTHETIC CHARGE', issuerCategory: 'Shopping' }] });
// STEP 9 integration (revocation)
const revoke = () => backedUpWrite(db(), backup(), () => revokeContradictedProofs(db(), NOW).revoked);
const twins = (o: OrderObservation) => {
  o.items = [0, 1].map(lineOrdinal => ({ lineOrdinal, itemId: 'SYNTH00001', title: 'Synthetic blue widget', quantity: 1,
    unitPrice: { currency: 'USD', amountMinor: 500 } }));
};
const picture = (o: OrderObservation) => { o.items[0].imageId = '91SynthAA0L'; };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-step9-integration-synthetic-')); backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('STEP 9 integration: #158 display rule with #168 facts from outside the order', () => {
  it('weighs a status taken back or a category that cannot follow only when the facts are passed', () => {
    const shown = detailed(1, refund(500)).staging.orders[0], next = detailed(2, refund(800)).staging.orders[0];
    expect(compareObservation(next, shown)).toBe('superset');
    expect(displayDecision(next, false, shown).kept).toBe(false);
    expect(displayDecision(next, false, shown, { statusRegressed: true })).toEqual({ headerOnly: false, relation: 'conflict', kept: true });
    expect(displayDecision(next, false, shown, { categoriesUnmatched: true })).toEqual({ headerOnly: false, relation: 'conflict', kept: true });
    // A witnessed header-only read still never displaces details, whatever the outside facts.
    expect(displayDecision(proven(3).staging.orders[0], true, shown, {})).toMatchObject({ headerOnly: true, kept: true });
  });
  // STEP 9 integration (revocation)
  it('keeps a displayed proof until refund evidence revokes it, restores exactly the display it displaced, then lets only a progression that keeps its status update it', async () => {
    const first = detailed(1);
    await importAmazonCapture(db(), first, backup());
    // An uncontradicted proof supersedes the details, recording the display it displaced.
    await importAmazonCapture(db(), proven(2), backup());
    expect(displayedObservation().chargeFree).toEqual({ status: 'cancelled-not-charged', shipments: 1 });
    expect(audits('charge-free-superseded-details')).toBe(1);
    // Refund evidence for the order is money evidence: the proof is revoked and exactly the display it displaced returns.
    // The read that brought the evidence was weighed against the proof at its own import: history only (Root).
    const issued = withRefundEvidence(detailed(3, refund(500)), [stated('completed')]);
    const revoking = await importAmazonCapture(db(), issued, backup());
    expect(revoking.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(audits('charge-free-revoked')).toBe(1);
    expect(displayedObservation()).toEqual(first.staging.orders[0]);
    expect(listRefundEvents(db())).toEqual([expect.objectContaining({ kind: 'refund', status: 'completed' })]);
    const restored = row();
    // The next real read is weighed by the ordinary rules: a larger Refund Total whose own statement takes the refund back
    // to pending is a conflict, kept and flagged.
    const takenBack = withRefundEvidence(detailed(4, refund(800)), [stated('pending')]);
    const regressing = await importAmazonCapture(db(), takenBack, backup());
    expect(row()).toEqual(restored);
    expect(audits('refund-status-regressed')).toBe(1);
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(regressing.holds).toContainEqual({ reason: 'refund-status-regressed', count: 1 });
    expect(displayedObservation().chargeFree).toBeUndefined();
    // The same progression with no status taken back updates the display.
    await importAmazonCapture(db(), detailed(5, refund(800)), backup());
    expect(row().latest_digest).not.toBe(restored.latest_digest);
    expect(shownOrder().refundSummary).toEqual({ currency: 'USD', amountMinor: 800 });
    expect(audits('refund-status-regressed')).toBe(1);
    expect(audits('charge-free-revoked')).toBe(1);
  });
  it('carries an owner category through the shared display rule after a revoked proof', async () => {
    await importAmazonCapture(db(), detailed(1), backup());
    await importAmazonCapture(db(), proven(2), backup());
    await importAmazonCapture(db(), withRefundEvidence(detailed(3, refund(500)), [stated('completed')]), backup());
    expect(audits('charge-free-revoked')).toBe(1);
    await decide(['Synthetic owner choice']);
    expect(shownOrder().items.map(i => [i.category, i.categorySource])).toEqual([['Synthetic owner choice', 'item-override']]);
    const shown = row();
    await importAmazonCapture(db(), detailed(4, refund(700)), backup());
    expect(row().latest_digest).not.toBe(shown.latest_digest);
    expect(audits('item-override-carried')).toBe(1);
    expect(shownOrder().items.map(i => [i.category, i.categorySource])).toEqual([['Synthetic owner choice', 'item-override']]);
    expect(shownOrder().refundSummary).toEqual({ currency: 'USD', amountMinor: 700 });
  });
  it('keeps the display, flagged, when an owner category cannot follow a superset to one line', async () => {
    await importAmazonCapture(db(), detailed(1, twins), backup());
    await decide(['Synthetic owner first', 'Synthetic owner second']);
    const shown = row();
    const receipt = await importAmazonCapture(db(), detailed(2, o => { twins(o); refund(300)(o); }), backup());
    expect(row()).toEqual(shown);
    expect(audits('item-category-unmatched')).toBe(1);
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(audits('item-override-carried')).toBe(0);
    expect(receipt.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
  });
});

describe('STEP 9 integration: a revocation restores exactly the display its proof displaced (Root)', () => {
  it('brings the owner category back when card evidence revokes the proof and the pre-proof display returns', async () => {
    const cardId = await bindCard();
    const first = detailed(1);
    await importAmazonCapture(db(), first, backup());
    await decide(['Synthetic owner choice']);
    await importAmazonCapture(db(), proven(2), backup());
    expect(displayedObservation().chargeFree).toEqual({ status: 'cancelled-not-charged', shipments: 1 });
    expect(shownOrder().items).toEqual([]);
    chargeCard(cardId);
    expect(await revoke()).toEqual([opaque('order', first.staging.orders[0].orderId)]);
    expect(displayedObservation()).toEqual(first.staging.orders[0]);
    expect(shownOrder().items.map(i => [i.category, i.categorySource])).toEqual([['Synthetic owner choice', 'item-override']]);
    expect(audits('charge-free-revoked')).toBe(1);
  });
  // STEP 9 integration (revocation)
  it('restores the displaced display, never a read kept while the proof was displayed; the next real read advances it', async () => {
    const cardId = await bindCard();
    const first = detailed(1);
    await importAmazonCapture(db(), first, backup());
    await decide(['Synthetic owner choice']);
    await importAmazonCapture(db(), proven(2), backup());
    // Read while the proof is displayed: poorer than the proof, so history only.
    await importAmazonCapture(db(), detailed(3, picture), backup());
    chargeCard(cardId);
    expect(await revoke()).toHaveLength(1);
    expect(displayedObservation()).toEqual(first.staging.orders[0]);
    expect(audits('item-override-carried')).toBe(0);
    expect(shownOrder().items.map(i => [i.category, i.categorySource])).toEqual([['Synthetic owner choice', 'item-override']]);
    const next = detailed(4, picture);
    await importAmazonCapture(db(), next, backup());
    expect(displayedObservation()).toEqual(next.staging.orders[0]);
    expect(audits('item-override-carried')).toBe(1);
    expect(shownOrder().items.map(i => [i.category, i.categorySource])).toEqual([['Synthetic owner choice', 'item-override']]);
  });
  it('never re-displays a read an earlier import kept back because a category could not follow', async () => {
    const cardId = await bindCard();
    const first = detailed(1, twins);
    await importAmazonCapture(db(), first, backup());
    await decide(['Synthetic owner first', 'Synthetic owner second']);
    await importAmazonCapture(db(), detailed(2, o => { twins(o); picture(o); }), backup());
    expect(audits('item-category-unmatched')).toBe(1);
    await importAmazonCapture(db(), proven(3), backup());
    expect(displayedObservation().chargeFree).toBeDefined();
    chargeCard(cardId);
    expect(await revoke()).toHaveLength(1);
    expect(displayedObservation()).toEqual(first.staging.orders[0]);
    expect(shownOrder().items.map(i => i.category)).toEqual(['Synthetic owner first', 'Synthetic owner second']);
    expect(audits('item-category-unmatched')).toBe(1);
    expect(audits('item-override-carried')).toBe(0);
  });
  // STEP 9 integration (revocation)
  it('restores the pre-proof display, never a read its import held, even after a later adoption (e36b4c32)', async () => {
    const cardId = await bindCard();
    // D0 reads the line without its ASIN, and the agent files its title key.
    const d0 = detailed(1, o => { o.items[0].itemId = null; });
    await importAmazonCapture(db(), d0, backup());
    const title = d0.staging.orders[0].items[0].title;
    const agentCategory = (asin: string | null) => backedUpWrite(db(), backup(), () => db().prepare(
      "INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')")
      .run(productKey({ asin, title }), 'Shopping', 0.9));
    await agentCategory(null);
    // D1 learns the ASIN: the agent category cannot follow the new key, so its import holds it back.
    const held = await importAmazonCapture(db(), detailed(2), backup());
    expect(held.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
    expect(displayedObservation()).toEqual(d0.staging.orders[0]);
    // A category review adopts the new key while D0 is still displayed; then a proof displaces D0.
    await agentCategory('SYNTH00001');
    await importAmazonCapture(db(), proven(3), backup());
    expect(displayedObservation().chargeFree).toBeDefined();
    // A posted card charge, then the same proof again (an exact repeat), revokes it: D0 returns, not the held D1.
    chargeCard(cardId);
    const repeat = await importAmazonCapture(db(), proven(3), backup());
    expect(repeat.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(displayedObservation()).toEqual(d0.staging.orders[0]);
    // The next real read is weighed by the ordinary rules: the adopted category now follows, so it replaces the display.
    const next = detailed(4);
    await importAmazonCapture(db(), next, backup());
    expect(displayedObservation()).toEqual(next.staging.orders[0]);
  });
  it('follows a displaced proof back to the display before it', async () => {
    const cardId = await bindCard();
    const first = detailed(1);
    await importAmazonCapture(db(), first, backup());
    await importAmazonCapture(db(), proven(2), backup());
    await importAmazonCapture(db(), proven(3), backup());
    expect(db().prepare('SELECT count(*) FROM amazon_proof_predecessors').pluck().get()).toBe(2);
    chargeCard(cardId);
    expect(await revoke()).toHaveLength(1);
    expect(displayedObservation()).toEqual(first.staging.orders[0]);
  });
  it('restores an unread header when the proof was the order\'s first display', async () => {
    const proof = proven(1);
    await importAmazonCapture(db(), proof, backup());
    const shown = row();
    expect(db().prepare('SELECT predecessor_digest,predecessor_json FROM amazon_proof_predecessors').get())
      .toEqual({ predecessor_digest: null, predecessor_json: null });
    const revoking = await importAmazonCapture(db(), withRefundEvidence(detailed(2, refund(500)), [stated('completed')]), backup());
    expect(revoking.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    const { chargeFree: _proof, ...header } = proof.staging.orders[0];
    expect(row().latest_digest).toBe(shown.latest_digest);
    expect(displayedObservation()).toEqual(header);
    const next = detailed(3, refund(500));
    await importAmazonCapture(db(), next, backup());
    expect(displayedObservation()).toEqual(next.staging.orders[0]);
  });
  it('fails closed when a contradicted proof has no recorded predecessor: the proof stays displayed, surfaced', async () => {
    const first = () => withRefundEvidence(detailed(1, refund(500)), [stated('completed')]);
    await importAmazonCapture(db(), first(), backup());
    // A proof displayed without its record (set directly: imports always record one).
    const orderRef = opaque('order', first().staging.orders[0].orderId), proof = proven(2).staging.orders[0];
    await backedUpWrite(db(), backup(), () => db().prepare('UPDATE amazon_orders SET data_json=? WHERE ref=?')
      .run(JSON.stringify(proof), orderRef));
    expect(await backedUpWrite(db(), backup(), () => revokeContradictedProofs(db(), NOW))).toEqual({ revoked: [], missing: [orderRef] });
    expect(displayedObservation()).toEqual(proof);
    expect(audits('revocation-predecessor-missing')).toBe(1);
    expect(audits('charge-free-revoked')).toBe(0);
    const repeat = await importAmazonCapture(db(), first(), backup());
    expect(repeat.holds).toContainEqual({ reason: 'revocation-predecessor-missing', count: 1 });
    expect(displayedObservation()).toEqual(proof);
  });
  it('STEP 9 integration (revocation, b56ba81f): surfaces a missing predecessor when only a posted card charge contradicts the proof', async () => {
    const cardId = await bindCard();
    const first = detailed(1), proof = proven(2);
    await importAmazonCapture(db(), first, backup());
    await importAmazonCapture(db(), proof, backup());
    expect(displayedObservation()).toEqual(proof.staging.orders[0]);
    // Its record lost (as for a proof displayed before the table was installed), then an ordinary posted charge of the
    // order's total, imported without any Amazon reconcile, then the same proof again (an exact repeat).
    await backedUpWrite(db(), backup(), () => { db().prepare('DELETE FROM amazon_proof_predecessors').run(); });
    chargeCard(cardId);
    const repeat = await importAmazonCapture(db(), proof, backup());
    expect(repeat.holds).toContainEqual({ reason: 'revocation-predecessor-missing', count: 1 });
    expect(displayedObservation()).toEqual(proof.staging.orders[0]);
    expect(audits('revocation-predecessor-missing')).toBe(1);
    expect(audits('charge-free-revoked')).toBe(0);
    // STEP 9 integration (revocation, Root): e36b4c32's legacy D -> P case surfaces it on every write, never silently: the
    // exact D again, a new header read, and the reconcile pass itself. The proof stays displayed throughout.
    const again = await importAmazonCapture(db(), first, backup());
    expect(again.holds).toContainEqual({ reason: 'revocation-predecessor-missing', count: 1 });
    const header = proven(3);
    delete header.staging.orders[0].chargeFree;
    const headerReceipt = await importAmazonCapture(db(), header, backup());
    expect(headerReceipt.holds).toContainEqual({ reason: 'revocation-predecessor-missing', count: 1 });
    expect(await backedUpWrite(db(), backup(), () => revokeContradictedProofs(db(), NOW)))
      .toEqual({ revoked: [], missing: [opaque('order', first.staging.orders[0].orderId)] });
    expect(displayedObservation()).toEqual(proof.staging.orders[0]);
    expect(audits('charge-free-revoked')).toBe(0);
  });
  for (const recorded of [true, false]) {
    it(`STEP 9 integration (revocation, Root, e36b4c32): a posted charge matching only a held read contradicts the proof: ${recorded ? 'D0 returns' : 'no record, surfaced'}`, async () => {
      const cardId = await bindCard();
      const d0 = detailed(1);
      await importAmazonCapture(db(), d0, backup());
      // D1 reads the order at another price (1100 + 100 tax = 1200): a conflict, kept back as history.
      const d1 = detailed(2, o => {
        o.items[0].unitPrice = { currency: 'USD', amountMinor: 1100 };
        o.total = { currency: 'USD', amountMinor: 1200 };
        o.summary = o.summary!.map(s => (s.kind === 'items-subtotal' ? { ...s, money: { currency: 'USD', amountMinor: 1100 } }
          : s.kind === 'grand-total' ? { ...s, money: { currency: 'USD', amountMinor: 1200 } } : s));
      });
      await importAmazonCapture(db(), d1, backup());
      expect(displayedObservation()).toEqual(d0.staging.orders[0]);
      const proof = proven(3);
      await importAmazonCapture(db(), proof, backup());
      if (!recorded) await backedUpWrite(db(), backup(), () => { db().prepare('DELETE FROM amazon_proof_predecessors').run(); });
      // A posted charge of D1's 1200 only (not D0's 1100), imported without any Amazon reconcile.
      repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic', parserVersion: 'synthetic@1',
        rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1200,
          description: 'AMAZON SYNTHETIC CHARGE', issuerCategory: 'Shopping' }] });
      const repeat = await importAmazonCapture(db(), proof, backup());
      if (recorded) {
        expect(displayedObservation()).toEqual(d0.staging.orders[0]);
        expect(audits('charge-free-revoked')).toBe(1);
      } else {
        expect(repeat.holds).toContainEqual({ reason: 'revocation-predecessor-missing', count: 1 });
        expect(displayedObservation()).toEqual(proof.staging.orders[0]);
        expect(audits('charge-free-revoked')).toBe(0);
      }
    });
  }
});

describe('STEP 9 integration: item taxonomy (#161) follows a display replacement like an owner decision (#168)', () => {
  const unlearned = (o: OrderObservation) => { o.items[0].itemId = null; };
  const title = 'Synthetic blue widget';
  const oldKey = productKey({ asin: null, title }), newKey = productKey({ asin: 'SYNTH00001', title });
  const assign = (key: string, source: 'owner' | 'agent', confidence: number) => backedUpWrite(db(), backup(), () => {
    installAmazonTaxonomySchema(db());
    db().prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)')
      .run(key, source, 'groceries/produce', confidence, 1, 'a'.repeat(64));
  });
  it('carries the owner taxonomy to the product key a learned ASIN gives the line', async () => {
    await importAmazonCapture(db(), detailed(1, unlearned), backup());
    await assign(oldKey, 'owner', 1);
    const shown = row();
    const learned = detailed(2);
    expect(compareObservation(learned.staging.orders[0], detailed(1, unlearned).staging.orders[0])).toBe('superset');
    await importAmazonCapture(db(), learned, backup());
    expect(row().latest_digest).not.toBe(shown.latest_digest);
    expect(audits('taxonomy-owner-carried')).toBe(1);
    expect(readTaxonomyAssignments(db()).get(newKey)).toEqual({ node: 'groceries/produce', source: 'owner', confidence: 1 });
    expect(db().prepare('SELECT taxonomy_version,mapping_digest FROM amazon_product_taxonomy WHERE product_key=? AND source=?')
      .get(newKey, 'owner')).toEqual({ taxonomy_version: 1, mapping_digest: 'a'.repeat(64) });
    // STEP 9 integration (B2-fix)
    expect(audits('taxonomy-unmatched')).toBe(0);
  });
  it('keeps the display, flagged, when an agent taxonomy node would not follow a learned ASIN', async () => {
    await importAmazonCapture(db(), detailed(1, unlearned), backup());
    await assign(oldKey, 'agent', 0.9);
    const shown = row();
    const receipt = await importAmazonCapture(db(), detailed(2), backup());
    expect(row()).toEqual(shown);
    // STEP 9 integration (B2-fix)
    expect(audits('taxonomy-unmatched')).toBe(1);
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(receipt.holds).toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    expect(audits('taxonomy-owner-carried')).toBe(0);
    expect(readTaxonomyAssignments(db()).get(newKey)).toBeUndefined();
    // Once the next GO'd taxonomy review gives the new key the same node, the next read replaces the display.
    await assign(newKey, 'agent', 0.9);
    await importAmazonCapture(db(), detailed(3), backup());
    expect(row().latest_digest).not.toBe(shown.latest_digest);
    expect(audits('taxonomy-unmatched')).toBe(1);
  });

  // Root's B2 ruling, with bd744359's matrix: a taxonomy decision is (node, source, confidence). It follows a learned
  // ASIN only to a key without any row (the owner's carries; the agent's waits for its adoption) or to a key whose
  // decision is identical. Any other row keeps the display, flagged; the new key's rows are never overwritten.
  type Decision = { source: 'owner' | 'agent'; node: string; confidence: number };
  const PRODUCE = 'groceries/produce', DAIRY = 'groceries/dairy-eggs';
  const owner = (node: string): Decision => ({ source: 'owner', node, confidence: 1 });
  const agent = (node: string, confidence: number): Decision => ({ source: 'agent', node, confidence });
  const put = (key: string, decisions: Decision[]) => backedUpWrite(db(), backup(), () => {
    installAmazonTaxonomySchema(db());
    for (const d of decisions) {
      db().prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)').run(key, d.source, d.node, d.confidence, 1, 'b'.repeat(64));
    }
  });
  const rowsOf = (key: string) => db().prepare(`SELECT source,node,confidence FROM amazon_product_taxonomy WHERE product_key=?
    ORDER BY source`).all(key) as Decision[];
  const bySource = (decisions: Decision[]) => [...decisions].sort((a, b) => a.source.localeCompare(b.source));
  const matrix: Array<[name: string, old: Decision, existing: Decision[], replaced: boolean]> = [
    ['an owner decision to a key without rows: carried', owner(PRODUCE), [], true],
    ['an owner decision to the same owner decision', owner(PRODUCE), [owner(PRODUCE)], true],
    ['an owner decision to another owner node (bd 1): held', owner(PRODUCE), [owner(DAIRY)], false],
    ['an owner decision to an agent row: held', owner(PRODUCE), [agent(DAIRY, 0.9)], false],
    ['an agent decision to a key without rows: held until adopted', agent(PRODUCE, 0.9), [], false],
    ['an agent decision to the same agent decision', agent(PRODUCE, 0.9), [agent(PRODUCE, 0.9)], true],
    ['an agent decision to another agent node: held', agent(PRODUCE, 0.9), [agent(DAIRY, 0.9)], false],
    ['an agent decision to an owner node: held', agent(PRODUCE, 0.9), [owner(DAIRY)], false],
    ['an agent decision to the same node at another confidence (bd 2): held', agent(PRODUCE, 0.9), [agent(PRODUCE, 0.2)], false],
    ['an agent decision to the same node from another source: held', agent(PRODUCE, 0.9), [owner(PRODUCE)], false],
  ];
  for (const [name, old, existing, replaced] of matrix) {
    it(`Root's B2 matrix: ${name}`, async () => {
      await importAmazonCapture(db(), detailed(1, unlearned), backup());
      await put(oldKey, [old]);
      if (existing.length) await put(newKey, existing);
      const shown = row(), decided = readTaxonomyAssignments(db()).get(oldKey);
      const receipt = await importAmazonCapture(db(), detailed(2), backup());
      expect(row().latest_digest !== shown.latest_digest).toBe(replaced);
      // What the order displays keeps its decision either way: the displayed line's key resolves as before.
      expect(readTaxonomyAssignments(db()).get(replaced ? newKey : oldKey)).toEqual(decided);
      expect(receipt.holds.some(h => h.reason === 'taxonomy-unmatched')).toBe(!replaced);
      const carried = replaced && existing.length === 0;
      expect(audits('taxonomy-owner-carried')).toBe(carried ? 1 : 0);
      expect(rowsOf(newKey)).toEqual(bySource(carried ? [old] : existing));
    });
  }
});
