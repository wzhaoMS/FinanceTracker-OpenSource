import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { digest, LEDGER_POLICY_DIGEST, opaque, SOURCE } from './policy.js';
import { listAmazonOrders } from './readModel.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { ensureAmazonSchema } from './schema.js';
import { LEDGER_GATE_CODES, ledgerChargeProof, type LedgerGateContext, type SavedGateLedger } from './savedLedgerGate.js';
import { gatePassed, importSavedOrders, linkedCardRows, parseSavedOrders, savedOrdersGate, type SavedOrdersFile } from './savedOrders.js';
import { splitRef } from './tipSplit.js';
import { rootApproval, syntheticCapture, syntheticSubject } from './fixtures.testSupport.js';
import { SAVED_CLASSIC, SAVED_FRESH, syntheticSavedOrders } from './savedOrdersFixtures.testSupport.js';
import type { LedgerRow, MatchResult, MatchSubject, PaymentObservation } from './types.js';

// Entirely synthetic: invented order IDs, card endings, descriptors and amounts. The saved Fresh order is 2369 in all with
// a 300 tip (so 2069 to prove), dated 2026-09-10; the classic one is 1100, untipped, dated 2026-09-01. Both on Visa 9001.
const TODAY = '2026-10-24', NOW = '2026-10-24T05:00:00.000Z';
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const A = 'AMAZON.COM*SYNTH CHARGE A', B = 'AMAZON.COM*SYNTH CHARGE B', C = 'AMAZON.COM*SYNTH CHARGE C';
const TIP_ROW = 'AMAZON TIPS*SYNTH', OTHER_ORDER = '000-0000099-0000099';
const SUPERSEDED_PART = { state: 'held', reason: 'superseded', candidateCount: 0 };
const DEFERRED_PART = { state: 'held', reason: 'deferred', candidateCount: 0 };
const ledger = (code: SavedGateLedger['code'], members: number, anchors: number, duplicates = 0, tip: 0 | 1 = 0): SavedGateLedger =>
  ({ code, members, anchors, duplicates, tip });

let dir: string, repo: SqliteStateRepo, backups = 0, visa9001: string, visa9002: string;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backups}.db`);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-saved-ledger-synthetic-'));
  backups = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  visa9001 = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' }).id;
  visa9002 = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD' }).id;
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: visa9001 },
    { network: 'visa', last4: '9002', cardAccountId: visa9002 }], readCardInventory(db()));
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

/** Posted purchases on a card (Visa 9001 unless named), dated 2026-09-11 unless given. */
const rows = (entries: Array<[amountMinor: number, description: string, transactionDate?: string]>, cardAccountId = visa9001) =>
  repo.importCardTransactions({ cardAccountId, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: entries.map(([amountMinor, description, transactionDate]) => ({ transactionDate: transactionDate ?? '2026-09-11',
      status: 'posted' as const, kind: 'purchase' as const, amountMinor, currency: 'USD', description, issuerCategory: 'Shopping' })) });
const rowBy = (description: string) => db().prepare('SELECT id FROM card_transactions WHERE description=?').pluck().get(description) as string;

interface Charge { amount: number; date?: string; last4?: string; orderIds?: string[]; pending?: true; refund?: true; repeat?: true }
/**
 * One payments-ledger capture as the ledger operator's slices are: no orders, only ledger rows, each Charged (or Pending,
 * or Refunded) on Visa 9001 naming the saved Fresh order and dated 2026-09-11, unless told otherwise.
 */
function ledgerCapture(charges: Charge[], run = 1) {
  const c = syntheticCapture();
  c.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  c.staging.orders = [];
  c.staging.payments = charges.map((charge, ordinal): PaymentObservation => ({
    date: charge.date ?? '2026-09-11', money: usd(charge.refund ? -charge.amount : charge.amount),
    kind: charge.pending ? 'unknown' : charge.refund ? 'refund' : 'charge', status: charge.pending ? 'pending' : 'completed',
    method: { kind: 'card', network: 'visa', last4: charge.last4 ?? '9001' }, orderIds: charge.orderIds ?? [SAVED_FRESH],
    identity: charge.repeat ? 'ambiguous-repeat' : 'native-row',
    provenance: { source: 'ledger', status: charge.pending ? 'Pending' : charge.refund ? 'Refunded' : 'Charged', page: 0, ordinal } }));
  const none = { status: 'held' as const, reason: 'selector-failed' as const, pages: 0, records: 0, rejected: 0 };
  const refunds = charges.filter(charge => charge.refund).length;
  c.staging.coverage = { orders: none, details: none,
    refunds: refunds ? { status: 'partial', reason: 'budget', pages: 1, records: refunds, rejected: 0 } : none,
    payments: { status: 'partial', reason: 'budget', pages: 1, records: charges.length, rejected: 0 } };
  return c;
}
const importLedger = (charges: Charge[], run = 1) => importAmazonCapture(db(), ledgerCapture(charges, run), backup(), NOW);
const importSaved = async (file: SavedOrdersFile) => {
  const parsed = await parseSavedOrders(file, TODAY);
  return db().transaction(() => {
    ensureAmazonSchema(db());
    return importSavedOrders(db(), parsed, digest(file), NOW);
  }).immediate();
};
const fresh = () => { const file = syntheticSavedOrders(); file.orders = [file.orders[1]]; return file; };
const classic = () => { const file = syntheticSavedOrders(); file.orders = [file.orders[0]]; return file; };
/** The gate again, as it reads the database now, for `file` as written in `captureDigest`. */
const regate = async (file: SavedOrdersFile, captureDigest: string) => {
  const parsed = await parseSavedOrders(file, TODAY);
  return savedOrdersGate(db(), parsed.file, linkedCardRows(db()), captureDigest, parsed.indexes).orders[0];
};
const stored = (ref: string) => {
  const text = db().prepare(`SELECT data_json FROM amazon_matches WHERE subject_ref=?
    UNION ALL SELECT data_json FROM amazon_ledger_matches WHERE subject_ref=?`).pluck().get(ref, ref) as string | undefined;
  return text ? JSON.parse(text) as MatchResult : undefined;
};
const ledgerResults = () => (db().prepare('SELECT data_json FROM amazon_ledger_matches ORDER BY subject_ref').pluck().all() as string[])
  .map(text => JSON.parse(text) as MatchResult);
/** The ledger observation linked to a card row. */
const anchorOf = (row: string) => ledgerResults().find(r => r.state === 'linked' && r.cardTransactionId === row)!.subjectRef;
const restore = (result: MatchResult) => db().prepare('UPDATE amazon_ledger_matches SET data_json=? WHERE subject_ref=?')
  .run(JSON.stringify(result), result.subjectRef);
/** Everything a held order's import may never change: its display, history, subjects and matches, and every ledger result. */
const orderState = (orderId: string) => {
  const refs = [opaque('order-total', orderId), splitRef(orderId, 'order'), splitRef(orderId, 'tip')];
  return {
    order: db().prepare('SELECT latest_digest,data_json FROM amazon_orders WHERE ref=?').get(opaque('order', orderId)),
    history: db().prepare("SELECT ref FROM amazon_observations WHERE family='order' AND order_ref=? ORDER BY ref").pluck()
      .all(opaque('order', orderId)),
    subjects: refs.map(ref => db().prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(ref)),
    matches: refs.map(ref => db().prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck().get(ref)),
    ledger: db().prepare('SELECT subject_ref,state,card_transaction_id,data_json FROM amazon_ledger_matches ORDER BY subject_ref').all(),
  };
};

describe('the saved-pages gate\'s ledger branch (design v2, Root\'s path L)', () => {
  it('names exactly the design\'s closed codes', () => {
    expect(LEDGER_GATE_CODES).toEqual(['passed', 'ledger-total-ineligible', 'ledger-part-ineligible', 'ledger-other-evidence',
      'ledger-none', 'ledger-pending', 'ledger-multi-order', 'ledger-method', 'ledger-tip-ambiguous', 'ledger-unlinked',
      'ledger-shared-row', 'ledger-sum']);
  });

  it('passes a held tipped order on its own two linked ledger charges, writing no link and claiming no other row', async () => {
    rows([[1000, A], [1069, B]]);
    await importLedger([{ amount: 1000 }, { amount: 1069 }]);
    const links = linkedCardRows(db());
    expect([...links.keys()].sort()).toEqual([rowBy(A), rowBy(B)].sort());
    const outcome = await importSaved(fresh());
    expect(outcome.trial).toMatchObject({ passed: 1, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
    const gate = outcome.written!.gate;
    expect(gatePassed(gate)).toBe(true);
    expect(gate.orders[0]).toMatchObject({ index: 0, family: 'uff', fresh: true, displayed: true, consistent: true, sameFacts: true,
      state: 'held', reason: 'no-candidate', candidateCount: 0, charge: 'ledger', orderPart: SUPERSEDED_PART, tipPart: DEFERRED_PART,
      ledger: ledger('passed', 2, 2), passed: true });
    // The gate infers nothing: every link is the matcher's, unchanged by the write.
    expect(outcome.written!.receipt).toMatchObject({ newMatches: 0, invalidated: 0 });
    expect(linkedCardRows(db())).toEqual(links);
    // Its members are candidates only in the ledger candidates: no total, part or tip has a card row candidate.
    expect(db().prepare('SELECT count(*) FROM amazon_candidates').pluck().get()).toBe(0);
    expect(db().prepare('SELECT card_transaction_id FROM amazon_ledger_candidates ORDER BY card_transaction_id').pluck().all())
      .toEqual([...links.keys()].sort());
    for (const row of links.keys()) {
      expect(stored(anchorOf(row))).toMatchObject({ state: 'linked', reason: 'unique', policyDigest: LEDGER_POLICY_DIGEST });
    }
  });

  it('passes three charges that sum exactly (a triple)', async () => {
    rows([[500, A], [700, B], [869, C]]);
    await importLedger([{ amount: 500 }, { amount: 700 }, { amount: 869 }]);
    const outcome = await importSaved(fresh());
    expect(outcome.written!.gate.orders[0]).toMatchObject({ charge: 'ledger', ledger: ledger('passed', 3, 3), passed: true });
    expect(gatePassed(outcome.written!.gate)).toBe(true);
  });

  it('passes where a completed refund also names the order: it is no charge, so no member', async () => {
    rows([[1000, A], [1069, B]]);
    await importLedger([{ amount: 1000 }, { amount: 1069 }, { amount: 499, refund: true, date: '2026-09-20' }]);
    const outcome = await importSaved(fresh());
    expect(outcome.written!.gate.orders[0]).toMatchObject({ charge: 'ledger', ledger: ledger('passed', 2, 2), passed: true });
  });

  it('passes an untipped order on charges summing to its exact total', async () => {
    rows([[600, A, '2026-09-02'], [500, B, '2026-09-02']]);
    await importLedger([{ amount: 600, date: '2026-09-02', orderIds: [SAVED_CLASSIC] },
      { amount: 500, date: '2026-09-02', orderIds: [SAVED_CLASSIC] }]);
    const outcome = await importSaved(classic());
    expect(outcome.written!.gate.orders[0]).toMatchObject({ family: 'classic', state: 'held', reason: 'no-candidate', charge: 'ledger',
      orderPart: null, tipPart: null, ledger: ledger('passed', 2, 2), passed: true });
    expect(gatePassed(outcome.written!.gate)).toBe(true);
  });

  it('passes a repeated run: each verified corroboration, its stored candidate included, collapses into its anchor', async () => {
    rows([[1000, A], [1069, B]]);
    await importLedger([{ amount: 1000 }, { amount: 1069 }], 1);
    await importLedger([{ amount: 1000 }, { amount: 1069 }], 2);
    const aliases = ledgerResults().filter(r => r.reason === 'corroborated');
    expect(aliases.map(r => r.corroboratedBy).sort()).toEqual([anchorOf(rowBy(A)), anchorOf(rowBy(B))].sort());
    // Each alias keeps its own candidate on its anchor's row.
    expect(db().prepare('SELECT count(*) FROM amazon_ledger_candidates').pluck().get()).toBe(4);
    const outcome = await importSaved(fresh());
    expect(outcome.written!.gate.orders[0]).toMatchObject({ charge: 'ledger', ledger: ledger('passed', 4, 2, 2), passed: true });
    expect(gatePassed(outcome.written!.gate)).toBe(true);
  });

  describe('the tip\'s own charge (T)', () => {
    it('passes with T: unlinked, its only would-be row the tips row, which stays unlinked; T\'s view and the web keep it all',
      async () => {
        rows([[1000, A], [1069, B], [300, TIP_ROW, '2026-09-12']]);
        await importLedger([{ amount: 1000 }, { amount: 1069 }, { amount: 300 }]);
        expect(ledgerResults().filter(r => r.state === 'held').map(r => [r.reason, r.candidateCount])).toEqual([['no-candidate', 0]]);
        const outcome = await importSaved(fresh());
        expect(outcome.written!.gate.orders[0]).toMatchObject({ charge: 'ledger', ledger: ledger('passed', 3, 2, 0, 1), passed: true });
        expect(gatePassed(outcome.written!.gate)).toBe(true);
        expect(linkedCardRows(db()).has(rowBy(TIP_ROW))).toBe(false);
        // T's view of the order is its stored results, aliases and inert split parts aside: two charges, its total and T.
        const orderRef = opaque('order', SAVED_FRESH);
        const view = createAmazonCategoryResolver(db()).snapshot().getOrderMatches(orderRef);
        expect(view).toHaveLength(4);
        expect(view).toEqual(expect.arrayContaining([
          { state: 'linked', evidenceClass: 'payment-ledger-complete', cardTransactionId: rowBy(A), cardAccountId: visa9001 },
          { state: 'linked', evidenceClass: 'payment-ledger-complete', cardTransactionId: rowBy(B), cardAccountId: visa9001 },
          { state: 'held', evidenceClass: 'payment-ledger-complete', reason: 'no-candidate', candidateCount: 0 },
          { state: 'held', evidenceClass: 'unique-total-match', reason: 'no-candidate', candidateCount: 0 }]));
        // The page's reader takes the order's matches whole: none is a reason it would refuse.
        const href = new URL('../../../../web/src/components/amazon/amazonApi.ts', import.meta.url).href;
        const web = await import(/* @vite-ignore */ href) as {
          parseAmazonOrderPage: (raw: unknown) => { orders: Array<{ ref: string; matches?: unknown[] }> } };
        const answer = listAmazonOrders(db(), 0, 100);
        const read = web.parseAmazonOrderPage(JSON.parse(JSON.stringify(answer)));
        expect(read.orders.find(o => o.ref === orderRef)!.matches).toEqual(answer.orders.find(o => o.ref === orderRef)!.matches);
      });
    it.each<[string, Array<[number, string, string?]>, Charge[], SavedGateLedger]>([
      ['two observations each qualify as T', [[1000, A], [1069, B], [300, `${TIP_ROW} ONE`, '2026-09-10'],
        [300, `${TIP_ROW} TWO`, '2026-09-27']],
      [{ amount: 1000 }, { amount: 1069 }, { amount: 300, date: '2026-09-08' }, { amount: 300, date: '2026-09-25' }],
      ledger('ledger-tip-ambiguous', 4, 2)],
      ['one observation of the tip has two tips rows (no carve-out: it is unlinked)', [[1000, A], [1069, B],
        [300, `${TIP_ROW} ONE`], [300, `${TIP_ROW} TWO`, '2026-09-12']],
      [{ amount: 1000 }, { amount: 1069 }, { amount: 300 }], ledger('ledger-unlinked', 3, 2)],
      ['the tip\'s observation is evidence-held, an ambiguous repeat (no carve-out: it is unlinked)', [[1000, A], [1069, B],
        [300, TIP_ROW]],
      [{ amount: 1000 }, { amount: 1069 }, { amount: 300, repeat: true }], ledger('ledger-unlinked', 3, 2)],
      ['the tip\'s charge links an ordinary row (an anchor, so the sum is over)', [[1000, A], [1069, B], [300, C]],
      [{ amount: 1000 }, { amount: 1069 }, { amount: 300 }], ledger('ledger-sum', 3, 3)],
    ])('holds the order where %s', async (_, entries, charges, expected) => {
      rows(entries);
      await importLedger(charges);
      const outcome = await importSaved(fresh());
      expect(outcome.held.map(o => [o.charge, o.ledger, o.passed])).toEqual([['none', expected, false]]);
      expect(outcome.written).toBeNull();
    });
  });

  describe('Root\'s five, and every hold changes nothing', () => {
    interface HeldCase {
      rows: Array<[number, string, string?]>; rows9002?: Array<[number, string, string?]>; charges: Charge[];
      orderPart?: { state: string; reason: string; candidateCount: number }; expected: SavedGateLedger;
    }
    const pair: HeldCase['rows'] = [[1000, A], [1069, B]];
    it.each<[string, HeldCase]>([
      ['a partial ledger (a charge short)', { rows: pair, charges: [{ amount: 1000 }], expected: ledger('ledger-sum', 1, 1) }],
      ['an extra Charged observation, linked to its own row', { rows: [...pair, [500, C]],
        charges: [{ amount: 1000 }, { amount: 1069 }, { amount: 500 }], expected: ledger('ledger-sum', 3, 3) }],
      ['an extra Charged observation of the whole total, with no row (its total eligible, the extra still counted)', { rows: pair,
        charges: [{ amount: 1000 }, { amount: 1069 }, { amount: 2369 }], expected: ledger('ledger-unlinked', 3, 2) }],
      ['charges a cent short', { rows: [[1000, A], [1068, B]], charges: [{ amount: 1000 }, { amount: 1068 }],
        expected: ledger('ledger-sum', 2, 2) }],
      ['a pending ledger row naming it', { rows: pair, charges: [{ amount: 1000 }, { amount: 1069 }, { amount: 2369, pending: true }],
        expected: ledger('ledger-pending', 2, 2) }],
      ['a ledger row naming it and another order', { rows: pair,
        charges: [{ amount: 1000 }, { amount: 1069 }, { amount: 777, orderIds: [SAVED_FRESH, OTHER_ORDER] }],
        expected: ledger('ledger-multi-order', 2, 2) }],
      ['its charges on another card than the saved one', { rows: [], rows9002: pair,
        charges: [{ amount: 1000, last4: '9002' }, { amount: 1069, last4: '9002' }], expected: ledger('ledger-method', 2, 2) }],
      ['no ledger row naming it', { rows: [], charges: [{ amount: 500, orderIds: [OTHER_ORDER] }],
        orderPart: { state: 'held', reason: 'no-candidate', candidateCount: 0 }, expected: ledger('ledger-none', 0, 0) }],
    ])('holds the order on %s', async (_, held) => {
      if (held.rows.length) rows(held.rows);
      if (held.rows9002) rows(held.rows9002, visa9002);
      await importLedger(held.charges);
      const links = linkedCardRows(db()), before = orderState(SAVED_FRESH);
      const outcome = await importSaved(fresh());
      expect(outcome.trial).toMatchObject({ passed: 0, failed: 1, linkedRowsLost: 0, linkedRowsMoved: 0 });
      expect(outcome.held.map(o => [o.state, o.reason, o.charge, o.orderPart, o.ledger, o.passed]))
        .toEqual([['held', 'no-candidate', 'none', held.orderPart ?? SUPERSEDED_PART, held.expected, false]]);
      expect(outcome.written).toBeNull();
      expect(orderState(SAVED_FRESH)).toEqual(before);
      expect(linkedCardRows(db())).toEqual(links);
    });
    it('holds the order where its tip\'s charge T is on another card', async () => {
      rows([[1000, A], [1069, B]]);
      rows([[300, TIP_ROW]], visa9002);
      await importLedger([{ amount: 1000 }, { amount: 1069 }, { amount: 300, last4: '9002' }]);
      const outcome = await importSaved(fresh());
      expect(outcome.held.map(o => [o.charge, o.ledger])).toEqual([['none', ledger('ledger-method', 3, 2, 0, 1)]]);
      expect(outcome.written).toBeNull();
    });
    it('holds the order where a native payment event names it (other evidence)', async () => {
      rows([[1000, A], [1069, B]]);
      await importLedger([{ amount: 1000 }, { amount: 1069 }]);
      // No importer writes a native payment event today: the guard is pinned on a seeded subject (as refundCredits' tests
      // seed them), here before its order exists, so without its order link row.
      const event: MatchSubject = syntheticSubject({ ref: opaque('subject', 'synthetic-native-event'),
        nativeOccurrenceId: 'synthetic-native-event', date: '2026-09-10', money: usd(2369), orderRefs: [opaque('order', SAVED_FRESH)],
        tenderProof: 'unknown' });
      db().prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)').run(event.ref, SOURCE, 'payment-event', event.nativeOccurrenceId,
        JSON.stringify(event));
      const outcome = await importSaved(fresh());
      expect(outcome.held.map(o => [o.charge, o.ledger])).toEqual([['none', ledger('ledger-other-evidence', 2, 2)]]);
      expect(outcome.written).toBeNull();
    });
    it('holds the order where its part had a candidate (ineligible), and never attempts it where its total links', async () => {
      rows([[2069, A], [2069, B, '2026-09-12']]);
      let outcome = await importSaved(fresh());
      expect(outcome.held.map(o => [o.orderPart, o.ledger])).toEqual([[{ state: 'held', reason: 'ambiguous', candidateCount: 2 },
        ledger('ledger-part-ineligible', 0, 0)]]);
      rows([[2369, C]]);
      outcome = await importSaved(fresh());
      expect(outcome.written!.gate.orders.map(o => [o.charge, o.ledger, o.passed])).toEqual([['total', null, true]]);
    });
  });

  describe('a superseded observation is never set aside', () => {
    it('holds the order on its ambiguous total where an extra observation of the whole total is superseded to it', async () => {
      // The order first links its total; the ledger then shows its two charges and the whole total on that total's row.
      rows([[1000, A], [1069, B], [2369, C]]);
      const first = await importSaved(fresh());
      expect(first.written!.gate.orders[0]).toMatchObject({ charge: 'total', ledger: null, passed: true });
      await importLedger([{ amount: 1000 }, { amount: 1069 }, { amount: 2369 }]);
      const total = stored(opaque('order-total', SAVED_FRESH))!;
      expect([total.state, total.reason, total.candidateCount]).toEqual(['held', 'ambiguous', 1]);
      const extra = ledgerResults().find(r => r.reason === 'superseded')!;
      expect(extra).toMatchObject({ state: 'held', corroboratedBy: opaque('order-total', SAVED_FRESH) });
      const captureDigest = first.written!.captureDigest;
      expect(await regate(fresh(), captureDigest)).toMatchObject({ charge: 'none', ledger: ledger('ledger-total-ineligible', 3, 2),
        passed: false });
      // Were its total eligible, the superseded observation still counts, unaccounted for: never dropped.
      db().prepare('UPDATE amazon_matches SET data_json=? WHERE subject_ref=?').run(JSON.stringify({ ...total, reason: 'no-candidate',
        candidateCount: 0 }), total.subjectRef);
      expect(await regate(fresh(), captureDigest)).toMatchObject({ charge: 'none', ledger: ledger('ledger-unlinked', 3, 2),
        passed: false });
    });
    it('the same order with the same ledger read first: held in the trial, which changes nothing', async () => {
      rows([[1000, A], [1069, B], [2369, C]]);
      await importLedger([{ amount: 1000 }, { amount: 1069 }, { amount: 2369 }]);
      const links = linkedCardRows(db()), before = orderState(SAVED_FRESH);
      const outcome = await importSaved(fresh());
      // On its trial the extra observation is superseded to the total, so its row is no longer linked: lost, and held.
      expect(outcome.trial).toMatchObject({ passed: 0, failed: 1, linkedRowsLost: 1, linkedRowsMoved: 0 });
      expect(outcome.held.map(o => [o.state, o.reason, o.candidateCount, o.charge, o.ledger]))
        .toEqual([['held', 'ambiguous', 1, 'none', ledger('ledger-total-ineligible', 3, 2)]]);
      expect(outcome.written).toBeNull();
      expect(orderState(SAVED_FRESH)).toEqual(before);
      expect(linkedCardRows(db())).toEqual(links);
    });
  });

  describe('guards for states the matcher never stores (a unique anchor\'s row has one claim), read by the gate itself', () => {
    const passing = async () => {
      rows([[1100, 'AMAZON.COM*SYNTH CLASSIC', '2026-09-02'], [1000, A], [1069, B]]);
      await importLedger([{ amount: 1000 }, { amount: 1069 }]);
      const outcome = await importSaved(syntheticSavedOrders());
      // The classic order passes on its total, never attempting the ledger branch; the Fresh one on its ledger charges.
      expect(outcome.written!.gate.orders.map(o => [o.index, o.charge, o.ledger])).toEqual([[0, 'total', null],
        [1, 'ledger', ledger('passed', 2, 2)]]);
      return outcome.written!.captureDigest;
    };
    it('holds where another subject also has an anchor\'s row as a candidate, in either candidate table', async () => {
      const captureDigest = await passing();
      const a = rowBy(A), b = rowBy(B);
      // Another order's total.
      db().prepare('INSERT INTO amazon_candidates VALUES(?,?,?)').run(opaque('order-total', SAVED_CLASSIC), a, 'unique-total-match');
      expect((await regate(fresh(), captureDigest)).ledger).toEqual(ledger('ledger-shared-row', 2, 2));
      db().prepare('DELETE FROM amazon_candidates WHERE card_transaction_id=?').run(a);
      expect((await regate(fresh(), captureDigest)).ledger).toEqual(ledger('passed', 2, 2));
      // A ledger subject of another charge class.
      db().prepare('INSERT INTO amazon_ledger_candidates VALUES(?,?,?)').run(anchorOf(b), a, 'payment-ledger-complete');
      expect((await regate(fresh(), captureDigest)).ledger).toEqual(ledger('ledger-shared-row', 2, 2));
      db().prepare('DELETE FROM amazon_ledger_candidates WHERE subject_ref=? AND card_transaction_id=?').run(anchorOf(b), a);
      expect((await regate(fresh(), captureDigest)).ledger).toEqual(ledger('passed', 2, 2));
    });
    it('holds where two anchors name one row', async () => {
      const captureDigest = await passing();
      const second = stored(anchorOf(rowBy(B)))!;
      restore({ ...second, cardTransactionId: rowBy(A) });
      expect((await regate(fresh(), captureDigest)).ledger).toEqual(ledger('ledger-shared-row', 2, 2));
    });
    it('takes as an anchor only a link under LEDGER_POLICY', async () => {
      const captureDigest = await passing();
      const second = stored(anchorOf(rowBy(B)))!;
      restore({ ...second, policyDigest: digest('synthetic-other-policy') });
      expect((await regate(fresh(), captureDigest)).ledger).toEqual(ledger('ledger-unlinked', 2, 1));
    });
    it('counts a corroboration whose anchor is outside S, and holds: unlinked', async () => {
      rows([[1000, A], [1069, B]]);
      await importLedger([{ amount: 1000 }, { amount: 1069 }], 1);
      await importLedger([{ amount: 1000 }, { amount: 1069 }], 2);
      const outcome = await importSaved(fresh());
      expect(outcome.written!.gate.orders[0].ledger).toEqual(ledger('passed', 4, 2, 2));
      const alias = ledgerResults().find(r => r.reason === 'corroborated')!;
      restore({ ...alias, corroboratedBy: opaque('order-total', SAVED_FRESH) });
      expect((await regate(fresh(), outcome.written!.captureDigest)).ledger).toEqual(ledger('ledger-unlinked', 4, 2, 1));
    });
  });

  it('proves the charge only: each failed outer fact still holds an order its ledger charges prove', async () => {
    rows([[1000, A], [1069, B]]);
    await importLedger([{ amount: 1000 }, { amount: 1069 }]);
    const outcome = await importSaved(fresh());
    const captureDigest = outcome.written!.captureDigest, proven = ledger('passed', 2, 2);
    const facts = (o: Awaited<ReturnType<typeof regate>>) => [o.displayed, o.consistent, o.sameFacts, o.charge, o.ledger, o.passed];
    expect(facts(await regate(fresh(), captureDigest))).toEqual([true, true, true, 'ledger', proven, true]);
    // Not this capture's display.
    expect(facts(await regate(fresh(), digest('synthetic-other-capture')))).toEqual([false, true, true, 'ledger', proven, false]);
    // Not the stored total's facts (another date).
    const moved = fresh();
    moved.orders[0].date = '2026-09-09';
    expect(facts(await regate(moved, captureDigest))).toEqual([true, true, false, 'ledger', proven, false]);
    // A conflicting history.
    db().prepare(`UPDATE amazon_observations SET data_json=json_set(data_json,'$.itemProof.conflict',json('true'))
      WHERE family='order' AND order_ref=?`).run(opaque('order', SAVED_FRESH));
    expect(facts(await regate(fresh(), captureDigest))).toEqual([true, false, true, 'ledger', proven, false]);
  });
});

describe('ledgerChargeProof on a synthetic context (a currency no capture can carry today)', () => {
  const ORDER = '000-0000021-0000021';
  const member = (n: number, amountMinor: number, patch: Partial<MatchSubject> = {}) => syntheticSubject({
    ref: opaque('subject', `synthetic-ledger-${n}`), evidenceClass: 'payment-ledger-complete', nativeOccurrenceId: null,
    money: usd(amountMinor), orderRefs: [opaque('order', ORDER)], tenderProof: 'unknown', ...patch });
  const linked = (s: MatchSubject, row: string): MatchResult => ({ subjectRef: s.ref, state: 'linked', reason: 'unique',
    candidateCount: 1, cardTransactionId: row, evidenceClass: 'payment-ledger-complete', policyDigest: LEDGER_POLICY_DIGEST });
  const total: MatchResult = { subjectRef: opaque('order-total', ORDER), state: 'held', reason: 'no-candidate', candidateCount: 0,
    cardTransactionId: null, evidenceClass: 'unique-total-match' };
  const context = (subjects: MatchSubject[], rowsOf: Array<[MatchSubject, string]>): LedgerGateContext => ({
    subjects, results: new Map([total, ...rowsOf.map(([s, row]) => linked(s, row))].map(r => [r.subjectRef, r])),
    owners: new Map(rowsOf.map(([s, row]) => [row, new Set([s.ref])])), bindings: () => [], rows: (): LedgerRow[] => [] });
  const order = { orderId: ORDER, total: usd(2100), tip: 0, network: 'visa', last4: '9001' };
  it('holds charges in another currency than the saved total\'s', () => {
    const a = member(1, 1000), b = member(2, 1100);
    expect(ledgerChargeProof(context([a, b], [[a, 'row-a'], [b, 'row-b']]), order)).toEqual(ledger('passed', 2, 2));
    const cad = { ...a, money: { currency: 'CAD', amountMinor: 1000 } };
    expect(ledgerChargeProof(context([cad, b], [[cad, 'row-a'], [b, 'row-b']]), order)).toEqual(ledger('ledger-method', 2, 2));
    expect(ledgerChargeProof(context([a, b], [[a, 'row-a'], [b, 'row-b']]), { ...order, total: { currency: 'EUR', amountMinor: 2100 } }))
      .toEqual(ledger('ledger-method', 2, 2));
  });
});
