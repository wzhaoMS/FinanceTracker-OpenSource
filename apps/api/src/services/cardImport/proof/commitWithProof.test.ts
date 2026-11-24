import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { paymentReconciliationReport } from '../../../cli/paymentReconciliationReport.js';
import { installCardPaymentDecisionsSchema } from '../../cardPaymentDecisions.js';
import { cardAccountEpoch, installCutoverReceiptSchema } from '../../guardedCardCommit.js';
import { cardSyncActorRef } from '../../cardSyncDigests.js';
import { assertProofReceipt, proofReceiptSha256, ProofReceiptInvalid, type ProofReceipt } from './receipt.js';
import { stopPermit } from './permit.js';
import { PROOF_QUERY_NAMES } from './request.js';
import { payloadText, ProofWorld, sha256, type ProofParams } from '../../../testing/cardImportProofWorld.js';
import type { CardAccount, CardImportDraftRow } from '@finance-tracker/shared';

// Synthetic only: fictional merchants, made-up amounts and references.
const worlds: ProofWorld[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });
const world = (options: { install?: boolean } = {}) => {
  const w = new ProofWorld(options);
  worlds.push(w);
  return w;
};

const MERCHANTS = ['NORTHWIND GROCERY', 'PROSEWARE BISTRO', 'SAMPLE STREAMING', 'FABRIKAM CAFE', 'CONTOSO HARDWARE', 'TAILSPIN'];
const SEPTEMBER = payloadText('amex', [
  { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
  { transactionDate: '2026-09-12', postedDate: '2026-09-13', amountMinor: 1850, kind: 'purchase', description: 'PROSEWARE BISTRO', externalId: 'proof-ref-2' },
], { start: '2026-09-01', end: '2026-09-30' });
const october = (statement: boolean | 'mismatch' = true) => payloadText('amex', [
  { transactionDate: '2026-10-02', postedDate: '2026-10-03', amountMinor: 999, kind: 'purchase', description: 'SAMPLE STREAMING', externalId: 'proof-ref-3' },
], { start: '2026-10-01', end: '2026-10-05' }, { statement });
const JOB = sha256('synthetic-proof-job-1');

/** A world with an Amex card whose September is imported by its owner, and ROOT's permit live for Amex. */
async function seeded(options: { live?: boolean } = {}) {
  const w = world();
  if (options.live !== false) w.live('amex');
  const card = w.account();
  await w.seed(card, SEPTEMBER);
  return { w, card };
}

/**
 * The commit, and whether the database is exactly as it was. Only the declared hold (a 409 with a proof code) or a commit
 * comes back; any other answer fails the test as an error, never as an assertion (ROOT's kill standard, addendum 3).
 */
async function attempt(w: ProofWorld, card: CardAccount, body: string, proof: ProofParams, extra: Record<string, string> = {}) {
  const before = w.image();
  const res = await w.commit(card, body, proof, extra);
  const held = res.status === 409 && typeof res.body.code === 'string' && res.body.code.startsWith('proof-');
  if (!held && (res.status < 200 || res.status >= 300)) throw new Error(`the commit route answered ${res.status}`);
  return { res, unchanged: w.image().equals(before) };
}

/** Assertion-only: refused with `code`, the database exactly as it was, and no merchant text in the answer. */
function expectHeld(attempted: Awaited<ReturnType<typeof attempt>>, code: string) {
  expect([attempted.res.status, attempted.res.body.code], attempted.res.text).toEqual([409, code]);
  expect(attempted.unchanged).toBe(true);
  for (const merchant of MERCHANTS) expect(attempted.res.text).not.toContain(merchant);
}

describe('E1: the service principal commits only with the proof', () => {
  it('refuses a service commit without proof parameters on both commit routes, writing nothing', async () => {
    const { w, card } = await seeded();
    const before = w.image();
    const commit = await w.post(`/card-imports/commit?cardAccountId=${card.id}`, october());
    expect([commit.status, commit.body.code]).toEqual([400, 'proof-required']);
    const cutover = await w.post(`/card-imports/cutover-commit?cardAccountId=${card.id}`, october());
    expect([cutover.status, cutover.body.code]).toEqual([400, 'proof-required']);
    expect(w.image().equals(before)).toBe(true);
  });

  it('leaves the signed-in owner\'s commit as it was', async () => {
    const { w, card } = await seeded();
    const res = await w.post(`/card-imports/commit?cardAccountId=${card.id}`, october(), 'session');
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toBeUndefined();
  });

  it('names the route\'s proof parameters as the proof module does', () => {
    expect(PROOF_QUERY_NAMES).toEqual(['proofJob', 'proofAttempt', 'proofDeadline', 'proofMode', 'proofStatementPolicy']);
  });

  it('refuses a malformed proof parameter by name, never echoing its value', async () => {
    const { w, card } = await seeded();
    const res = await w.post(`/card-imports/commit?cardAccountId=${card.id}&proofJob=h1:zz&proofAttempt=1&proofMode=automatic`
      + '&proofDeadline=d1:p&proofStatementPolicy=require-match', october());
    expect([res.status, res.body.code]).toEqual([400, 'proof-request-invalid']);
    expect(res.body.error).toContain('proofJob');
    expect(res.text).not.toContain('h1:zz');
  });

  it('refuses owner decisions in the runner\'s mode', async () => {
    const { w, card } = await seeded();
    const res = await w.commit(card, october(), { jobId: JOB }, { possibleDuplicates: 'import' });
    expect([res.status, res.body.code]).toEqual([400, 'proof-decisions-refused']);
  });
});

describe('a clean automatic import', () => {
  it('commits with a value-free receipt written in the same transaction, and a repeat answers it again writing nothing', async () => {
    const { w, card } = await seeded();
    const { res } = await attempt(w, card, october(), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    const receipt = res.body.proof as ProofReceipt;
    expect(receiptInvalid(receipt)).toBeUndefined();
    expect(receipt).toMatchObject({
      format: 'holdr.card-import-proof', version: 1, mode: 'automatic', route: 'commit', jobId: JOB, attempt: 1,
      cardAccountId: card.id, payloadSha256: sha256(october()), outcome: 'committed',
      counts: { rows: 1, new: 1, duplicate: 0, promoted: 0, contentTwinsSkipped: 0, held: 0, review: 0 },
      statement: 'match', completeness: { basis: 'statement-totals', interval: { from: '2026-10-01', to: '2026-10-05' } },
      replay: { new: 0, possibleDuplicate: 0, reapply: 'nothing-new' },
      coverage: { before: { from: '2026-09-01', through: '2026-09-30', gapDays: 0 },
        after: { from: '2026-09-01', through: '2026-10-05', gapDays: 0 }, move: 'forward' },
      payments: { returnedAdded: 0, conflicts: 0, pairsChangedOrGone: 0 }, links: { applicable: false },
      tables: 'unchanged', permit: { globalGeneration: 1, issuerGeneration: 1 }, seal: null,
    });
    expect(w.receiptCount()).toBe(1);
    const stored = JSON.parse(w.db.prepare('SELECT receipt_json FROM card_import_proof_receipts').pluck().get() as string);
    expect(proofReceiptSha256(stored)).toBe(proofReceiptSha256(receipt));
    for (const merchant of MERCHANTS) expect(JSON.stringify(receipt)).not.toContain(merchant);
    expect(w.logs.join('\n')).toMatch(/\[card-import-proof\] committed job [a-f0-9]{8} automatic committed/);

    const before = w.image();
    const again = await w.commit(card, october(), { jobId: JOB });
    expect(again.status, again.text).toBe(200);
    expect(again.body).toMatchObject({ imported: false, repeated: true, newCount: 0, duplicateCount: 1, proofLabel: 'committed' });
    expect(again.body.proof).toEqual(receipt);
    expect(w.image().equals(before)).toBe(true);
  });

  it('records a nothing-new outcome when every row is known and the coverage recorded', async () => {
    const { w, card } = await seeded();
    expect((await w.commit(card, october(), { jobId: JOB })).status).toBe(201);
    const second = await w.commit(card, october(), { jobId: sha256('synthetic-proof-job-2') });
    expect(second.status, second.text).toBe(200);
    expect(second.body.proof).toMatchObject({ outcome: 'nothing-new', counts: { new: 0, duplicate: 1 }, coverage: { move: 'none' } });
    expect(w.receiptCount()).toBe(2);
  });

  it('lets the operator kit commit an unchecked file under supervision, outside the permit', async () => {
    const { w, card } = await seeded({ live: false });
    const res = await w.commit(card, october(false), { jobId: JOB, mode: 'supervised', policy: 'allow-unchecked-no-figures' });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ mode: 'supervised', statement: 'unchecked', completeness: { basis: 'operator-attested' },
      permit: null });
  });
});

describe('every gate holds, rolling everything back', () => {
  it('holds without the proof tables', async () => {
    const w = world({ install: false });
    const card = w.account();
    await w.seed(card, SEPTEMBER);
    expectHeld(await attempt(w, card, october(), { jobId: JOB }), 'proof-schema-required');
  });

  it('holds an automatic commit without ROOT\'s live permit, and after a STOP', async () => {
    const { w, card } = await seeded({ live: false });
    expectHeld(await attempt(w, card, october(), { jobId: JOB }), 'proof-permit-dead');
    w.live('amex');
    stopPermit(w.db, 'amex', 'consent-off', new Date().toISOString(), new Date());
    expectHeld(await attempt(w, card, october(), { jobId: JOB }), 'proof-permit-dead');
    w.live('amex', 'daily-interim');
    stopPermit(w.db, '*', 'holdr-off', new Date().toISOString(), new Date());
    expectHeld(await attempt(w, card, october(), { jobId: JOB }), 'proof-permit-dead');
  });

  it('holds an account\'s first import, a new gap and a backward extension (D4)', async () => {
    const w = world();
    w.live('amex');
    const fresh = w.account();
    expectHeld(await attempt(w, fresh, october(), { jobId: JOB }), 'proof-coverage-first');
    const { w: v, card } = await seeded();
    const november = payloadText('amex', [{ transactionDate: '2026-11-02', postedDate: '2026-11-03', amountMinor: 700, kind: 'purchase',
      description: 'TAILSPIN', externalId: 'proof-ref-7' }], { start: '2026-11-01', end: '2026-11-05' }, { statement: true });
    expectHeld(await attempt(v, card, november, { jobId: JOB }), 'proof-coverage-gap');
    const august = payloadText('amex', [{ transactionDate: '2026-08-15', postedDate: '2026-08-16', amountMinor: 700, kind: 'purchase',
      description: 'TAILSPIN', externalId: 'proof-ref-8' }], { start: '2026-08-01', end: '2026-08-31' }, { statement: true });
    expectHeld(await attempt(v, card, august, { jobId: JOB }), 'proof-coverage-backward');
  });

  it('holds on the statement and on completeness without evidence', async () => {
    const { w, card } = await seeded();
    expectHeld(await attempt(w, card, october('mismatch'), { jobId: JOB }), 'proof-statement-mismatch');
    expectHeld(await attempt(w, card, october(false), { jobId: JOB }), 'proof-statement-unchecked');
    expectHeld(await attempt(w, card, october(false), { jobId: JOB, policy: 'allow-unchecked-no-figures' }), 'proof-completeness-unknown');
  });

  it('holds a file that leaves out a stored row inside its coverage (superset)', async () => {
    const { w, card } = await seeded();
    const partial = payloadText('amex', [
      { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
    ], { start: '2026-09-01', end: '2026-09-30' }, { statement: true });
    expectHeld(await attempt(w, card, partial, { jobId: JOB }), 'proof-superset');
  });

  it('holds a plan that needs an owner decision', async () => {
    const w = world();
    w.live('amex');
    const card = w.account();
    await w.seed(card, payloadText('amex', [
      { transactionDate: '2026-09-20', postedDate: '2026-09-21', amountMinor: 3100, kind: 'purchase', description: 'CONTOSO HARDWARE' },
    ], { start: '2026-09-01', end: '2026-09-30' }));
    const twin = payloadText('amex', [
      { transactionDate: '2026-09-20', postedDate: '2026-09-21', amountMinor: 3100, kind: 'purchase', description: 'CONTOSO HARDWARE', externalId: 'proof-ref-9' },
    ], { start: '2026-09-15', end: '2026-09-30' }, { statement: true });
    expectHeld(await attempt(w, card, twin, { jobId: JOB }), 'proof-plan-not-clean');
  });

  it('holds a job id seen with another payload', async () => {
    const { w, card } = await seeded();
    expect((await w.commit(card, october(), { jobId: JOB })).status).toBe(201);
    const other = payloadText('amex', [{ transactionDate: '2026-10-06', postedDate: '2026-10-07', amountMinor: 500, kind: 'purchase',
      description: 'TAILSPIN', externalId: 'proof-ref-6' }], { start: '2026-10-06', end: '2026-10-08' }, { statement: true });
    expectHeld(await attempt(w, card, other, { jobId: JOB }), 'proof-receipt-conflict');
  });

  it('holds a dead permit at F1, before the statement: a file that does not reconcile still holds as proof-permit-dead', async () => {
    const { w, card } = await seeded();
    stopPermit(w.db, 'amex', 'consent-off', new Date().toISOString(), new Date());
    expectHeld(await attempt(w, card, october('mismatch'), { jobId: JOB }), 'proof-permit-dead');
    w.live('amex');
    stopPermit(w.db, '*', 'holdr-off', new Date().toISOString(), new Date());
    expectHeld(await attempt(w, card, october('mismatch'), { jobId: JOB }), 'proof-permit-dead');
  });

  it('holds an account\'s first import before any later gate: with the decisions table in another shape, still proof-coverage-first', async () => {
    const w = world();
    w.live('amex');
    const fresh = w.account();
    w.db.exec('CREATE TABLE card_payment_decisions (id TEXT)');
    expect(w.repo.cardPaymentDecisionsSchemaState()).toBe('conflict');
    expectHeld(await attempt(w, fresh, october(), { jobId: JOB }), 'proof-coverage-first');
  });

  it('holds while the payments report counts a conflict, even exactly one (G-PAYMENTS conflicts)', async () => {
    const { w, card } = await seeded();
    // Since #280's R4 the report re-checks each rejection by the rules' own test of a pair, so on rows the rules read
    // consistently every conflict counter is zero by design, and no fixture makes one genuinely. The report is read through
    // a passthrough (at the end of this file) that adds exactly one conflict while `injected.conflicts` is set; the gate
    // reads the report's total as it always does. A pair the rules matched, a payment and its debit, stands throughout.
    const pay: CardImportDraftRow = { transactionDate: '2026-09-15', postedDate: '2026-09-16', amountMinor: -5000,
      kind: 'payment', description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', externalId: 'proof-pay-22' };
    await w.seed(card, payloadText('amex', [pay], { start: '2026-09-15', end: '2026-09-16' }));
    w.checking([{ date: '2026-09-16', amountMinor: -5000, description: 'AMEX EPAYMENT ACH PMT SAMPLE HOLDER' }]);
    installCardPaymentDecisionsSchema(w.db);
    expect(paymentReconciliationReport(w.db).conflicts.total).toBe(0);
    onTestFinished(() => { injected.conflicts = 0; });
    injected.conflicts = 1;
    expect(paymentReconciliationReport(w.db).conflicts).toMatchObject({ total: 1, autoPairOnRejectedRows: 1 });
    // The gate reads that total inside the import's transaction, after the plan is applied: it holds on the one conflict
    // and writes nothing (the transaction rolls back), while the pair stands as the rules matched it; the control below
    // commits with it, one pair before and after.
    expectHeld(await attempt(w, card, october(), { jobId: JOB }), 'proof-payments-conflicts');
    // The control: nothing added; nothing conflicts, and the same import commits.
    injected.conflicts = 0;
    expect(paymentReconciliationReport(w.db).conflicts.total).toBe(0);
    const res = await w.commit(card, october(), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ payments: { pairsBefore: 1, pairsAfter: 1, conflicts: 0 } });
  });
});

describe('the fence: resolve, attempts and the deadline (§3.8)', () => {
  it('fences a resolved attempt for good, lets the next attempt run, and answers a committed one with its receipt', async () => {
    const { w, card } = await seeded();
    const before = w.image();
    const unresolved = await w.resolve(card, october(), JOB, 1);
    expect([unresolved.status, unresolved.body]).toEqual([200, { proof: { outcome: 'not-committed' } }]);
    expect(w.db.prepare('SELECT max_resolved_attempt FROM card_import_proof_fences').pluck().get()).toBe(1);
    expect(w.image().equals(before)).toBe(false);
    expectHeld(await attempt(w, card, october(), { jobId: JOB, attempt: 1 }), 'proof-fence-expired');
    const second = await w.commit(card, october(), { jobId: JOB, attempt: 2 });
    expect(second.status, second.text).toBe(201);
    const resolved = await w.resolve(card, october(), JOB, 2);
    expect(resolved.body).toEqual({ proof: { outcome: 'committed', receipt: second.body.proof, label: 'committed' } });
    // A finished job answers its receipt whatever the fence says.
    expect((await w.commit(card, october(), { jobId: JOB, attempt: 1 })).body.repeated).toBe(true);
  });

  it('never lets a commit land after the client\'s deadline', async () => {
    const { w, card } = await seeded();
    expectHeld(await attempt(w, card, october(), { jobId: JOB, deadlineMs: Date.now() - 1000 }), 'proof-fence-expired');
  });

  it('refuses owner decisions and a preview digest in resolve', async () => {
    const { w, card } = await seeded();
    const res = await w.post(`/card-imports/commit?${w.proofQuery(card, { jobId: JOB, mode: 'resolve' }, { previewDigest: `ipv1:${'a'.repeat(64)}` })}`, october());
    expect([res.status, res.body.code]).toEqual([400, 'proof-request-invalid']);
  });
});

describe('D12: a pending row posted by its issuer reference', () => {
  const pending = (patch: Partial<CardImportDraftRow> = {}) => payloadText('amex', [
    { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
    { transactionDate: '2026-09-28', status: 'pending', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM CAFE PENDING',
      issuerCategory: 'Pending', externalId: 'proof-pend-1', ...patch },
  ], { start: '2026-09-01', end: '2026-09-30' });
  const posted = (patch: Partial<CardImportDraftRow> = {}) => payloadText('amex', [
    { transactionDate: '2026-09-28', postedDate: '2026-10-02', status: 'posted', amountMinor: 2500, kind: 'purchase',
      description: 'FABRIKAM CAFE', issuerCategory: 'Restaurant', externalId: 'proof-pend-1', ...patch },
  ], { start: '2026-10-01', end: '2026-10-05' }, { statement: true });
  async function withPending() {
    const w = world();
    w.live('amex');
    const card = w.account();
    await w.seed(card, pending());
    return { w, card };
  }

  it('passes a text-only change, and counts it and the category it moves', async () => {
    const { w, card } = await withPending();
    const res = await w.commit(card, posted(), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ counts: { rows: 1, new: 0, promoted: 1, duplicate: 0 },
      rows: { promoted: 1, promotedTextChanged: 1, promotedCategoryChanged: 1, changed: 0 } });
    const row = w.repo.listCardTransactions({ cardAccountId: card.id }).find((r) => r.status === 'posted' && r.amountMinor === 2500)!;
    expect([row.description, row.postedDate]).toEqual(['FABRIKAM CAFE', '2026-10-02']);
  });

  it('keeps an owner\'s category through the promotion', async () => {
    const { w, card } = await withPending();
    const row = w.repo.listCardTransactions({ cardAccountId: card.id }).find((r) => r.status === 'pending')!;
    w.repo.updateCardTransaction(row.id, { userCategory: 'Dining' }, { actorRef: cardSyncActorRef('proof-owner') });
    const res = await w.commit(card, posted(), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(w.repo.listCardTransactions({ cardAccountId: card.id }).find((r) => r.id === row.id)!.userCategory).toBe('Dining');
  });

  it('counts an issuer-category-only change as text, even when the owner\'s category hides its effect', async () => {
    const { w, card } = await withPending();
    const row = w.repo.listCardTransactions({ cardAccountId: card.id }).find((r) => r.status === 'pending')!;
    w.repo.updateCardTransaction(row.id, { userCategory: 'Dining' }, { actorRef: cardSyncActorRef('proof-owner') });
    const { res } = await attempt(w, card, posted({ description: 'FABRIKAM CAFE PENDING' }), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ rows: { promoted: 1, promotedTextChanged: 1, promotedCategoryChanged: 0, changed: 0 } });
    expect(w.repo.listCardTransactions({ cardAccountId: card.id }).find((r) => r.id === row.id)!.issuerCategory).toBe('Restaurant');
  });

  it('counts no text change for a promotion that rewrites none of the three', async () => {
    const { w, card } = await withPending();
    const res = await w.commit(card, posted({ description: 'FABRIKAM CAFE PENDING', issuerCategory: 'Pending' }), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ rows: { promoted: 1, promotedTextChanged: 0, promotedCategoryChanged: 0, changed: 0 } });
  });

  it('holds an amount change (a tip, a fuel hold) as a revision', async () => {
    const { w, card } = await withPending();
    expectHeld(await attempt(w, card, posted({ amountMinor: 2650 }), { jobId: JOB }), 'proof-revision');
  });

  it('holds a transaction-date change as a revision', async () => {
    const { w, card } = await withPending();
    expectHeld(await attempt(w, card, posted({ transactionDate: '2026-09-27' }), { jobId: JOB }), 'proof-revision');
  });
});

describe('G-PAYMENTS: the import\'s rows are those it inserted or promoted (ROOT; Astra\'s conditions)', () => {
  const AMEX_DEBIT = 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER';
  const payment = (patch: Partial<CardImportDraftRow> = {}): CardImportDraftRow => ({ transactionDate: '2026-09-27', status: 'pending',
    amountMinor: -5000, kind: 'payment', description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', externalId: 'proof-pay-2', ...patch });
  const september = (rows: CardImportDraftRow[]) => payloadText('amex', [
    { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
    ...rows,
  ], { start: '2026-09-01', end: '2026-09-30' });
  /** The import that posts the pending payment, by its issuer reference. */
  const posting = (patch: Partial<CardImportDraftRow> = {}) => payloadText('amex', [payment({ status: 'posted', postedDate: '2026-10-02', ...patch })],
    { start: '2026-10-01', end: '2026-10-05' }, { statement: true });
  async function withPayments(rows: CardImportDraftRow[]) {
    const w = world();
    w.live('amex');
    const card = w.account();
    await w.seed(card, september(rows));
    return { w, card };
  }

  // Each of (a) and (b) fails if the import's rows are narrowed back to the rows it inserted.
  it('(a) passes a pending payment the import posts that now pairs a checking debit', async () => {
    const { w, card } = await withPayments([payment()]);
    w.checking([{ date: '2026-09-28', amountMinor: -5000, description: AMEX_DEBIT }]);
    const { res } = await attempt(w, card, posting(), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ rows: { appeared: 0, promoted: 1, changed: 0 }, payments: { pairsBefore: 0, pairsAfter: 1,
      pairsAdded: 1, pairsChangedOrGone: 0, unmatchedDebitsBefore: 1, unmatchedDebitsAfter: 0 } });
  });

  it('(b) passes a pending payment the import posts that pairs nothing, as a new unmatched payment', async () => {
    const { w, card } = await withPayments([payment()]);
    const res = await w.commit(card, posting(), { jobId: JOB });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ rows: { promoted: 1 }, payments: { pairsAdded: 0, unmatchedPaymentsNew: 1 } });
  });

  it('(d) holds a promotion that takes the debit of an existing pair', async () => {
    // Paid on the 25th and matched; the payment pending since the 27th, once posted, is a second candidate for the debit.
    const { w, card } = await withPayments([payment({ transactionDate: '2026-09-25', status: 'posted', postedDate: '2026-09-26',
      externalId: 'proof-pay-1' }), payment()]);
    w.checking([{ date: '2026-09-26', amountMinor: -5000, description: AMEX_DEBIT }]);
    expectHeld(await attempt(w, card, posting(), { jobId: JOB }), 'proof-payments-pair');
  });

  it('never counts a payment whose posting is not a valid promotion: it holds as a revision first', async () => {
    const { w, card } = await withPayments([payment()]);
    w.checking([{ date: '2026-09-28', amountMinor: -5100, description: AMEX_DEBIT }]);
    expectHeld(await attempt(w, card, posting({ amountMinor: -5100 }), { jobId: JOB }), 'proof-revision');
  });
});

describe('the cutover route under the proof', () => {
  it('commits a guarded cutover with both receipts, repeats it, and refuses another job\'s guard', async () => {
    const w = world();
    installCutoverReceiptSchema(w.db);
    w.live('chase');
    const card = w.account('chase', '7531');
    await w.seed(card, payloadText('chase', [{ transactionDate: '2026-10-10', postedDate: '2026-10-11', amountMinor: 300, kind: 'purchase',
      description: 'TAILSPIN', externalId: 'proof-cut-0' }], { start: '2026-10-01', end: '2026-10-16' }));
    const body = payloadText('chase', [{ transactionDate: '2026-10-18', postedDate: '2026-10-19', amountMinor: 100, kind: 'purchase',
      description: 'SAMPLE STREAMING', externalId: 'proof-cut-1' }], { start: '2026-10-17', end: '2026-10-20' }, { statement: true });
    const letters = (hex: string) => 'h1:' + [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    const jobId = sha256('synthetic-cutover-job');
    // The guard as the Mac's manifest pins it: the account's epoch before the first commit, for every replay too.
    const guard = { jobId: letters(jobId), epoch: letters(cardAccountEpoch(w.db, card.id)),
      proposalDigest: letters(sha256('synthetic-proposal')), start: '2026-10-17', issuer: 'chase', owner: 'alex', currency: 'USD',
      last4: '7531', previewDigest: w.repo.previewCardImport({ cardAccountId: card.id, payload: JSON.parse(body) }).previewDigest };
    const cutover = (proofJob = jobId) => w.post(`/card-imports/cutover-commit?${w.proofQuery(card, { jobId: proofJob }, guard)}`, body);
    const mismatch = await cutover(sha256('another-job'));
    expect([mismatch.status, mismatch.body.code]).toEqual([400, 'proof-request-invalid']);
    const first = await cutover();
    expect(first.status, first.text).toBe(200);
    expect(first.body.receipt).toMatchObject({ jobId, newCount: 1 });
    expect(first.body.proof).toMatchObject({ route: 'cutover', jobId, outcome: 'committed', counts: { new: 1 } });
    const before = w.image();
    const again = await cutover();
    expect(again.body).toMatchObject({ repeated: true, receipt: first.body.receipt, proof: first.body.proof, proofLabel: 'committed' });
    expect(w.image().equals(before)).toBe(true);
  });
});

/**
 * The receipt's schema refusal, if it has one. Only a ProofReceiptInvalid is caught; anything else is re-thrown unchanged,
 * so it fails the test as an error, never as an assertion (ROOT's kill standard, addendum 3 (e) and ruling 8).
 */
function receiptInvalid(receipt: ProofReceipt): ProofReceiptInvalid | undefined {
  try {
    assertProofReceipt(receipt);
  } catch (caught) {
    if (!(caught instanceof ProofReceiptInvalid)) throw caught;
    return caught;
  }
  return undefined;
}

/**
 * The G-PAYMENTS conflicts test's passthrough: the payments report exactly as the gate reads it, plus `injected.conflicts`
 * conflicts (counted as automatic pairs on rejected rows) while that test sets it, and zero otherwise, so every other test
 * reads the report as it is. Hoisted by vitest above the imports, so no line above this one moves.
 */
const injected = vi.hoisted(() => ({ conflicts: 0 }));
vi.mock('../../../cli/paymentReconciliationReport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../cli/paymentReconciliationReport.js')>();
  const paymentReconciliationReport: typeof actual.paymentReconciliationReport = (db) => {
    const report = actual.paymentReconciliationReport(db);
    if (injected.conflicts === 0) return report;
    return { ...report, conflicts: { ...report.conflicts, total: report.conflicts.total + injected.conflicts,
      autoPairOnRejectedRows: report.conflicts.autoPairOnRejectedRows + injected.conflicts } };
  };
  return { ...actual, paymentReconciliationReport };
});
