import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { CheckingImportPayload } from '@finance-tracker/shared';
import { FAKE_MACHINE, controlEnvFixture, lockHolder } from '../control/testControl.js';
import { LIFECYCLE_LOCK, lockPath } from '../control/lifecycle.js';
import { installCardPaymentDecisionsSchema } from '../services/cardPaymentDecisions.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { runPaymentReconciliationCli } from './paymentReconciliation.js';
import {
  REPORT_CONFLICT,
  formatPaymentReconciliationReport,
  paymentReconciliationReport,
  reportWord,
  type PaymentReconciliationReport,
} from './paymentReconciliationReport.js';

// The dry run on a real database made by this build. Synthetic only: made-up descriptors in the shapes banks print
// (made-up references and holder), amounts, dates, last fours and slugs.

let dir: string, file: string, stdout: string, stderr: string;
const cleanups: Array<() => void> = [];
const NOW = new Date('2026-10-16T12:00:00.000Z');
const OWNER = { actorRef: `usr_${'e'.repeat(32)}` };
/** The environment with no control dir, as on a stack without one: no lease to take. */
const NO_CONTROL = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'HOLDR_CONTROL_DIR'));
const run = (args: string[], env: NodeJS.ProcessEnv = { ...NO_CONTROL, HOLDR_CONFIG: 'none' }) => runPaymentReconciliationCli(args, {
  env, now: () => NOW,
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const autopay = (last4: string, holder: string) => `CHASE CREDIT CRD AUTOPAY ***${last4} ${holder}`;

function row(patch: Partial<CardImportRow>): CardImportRow {
  return {
    transactionDate: '2026-09-10', postedDate: null, status: 'posted', amountMinor: -10_000, currency: 'USD',
    kind: 'payment', description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

function checking(institution: string, last4: string, coverage: { start: string; end: string }, rows: Array<[string, number, string]>): CheckingImportPayload {
  return {
    format: 'holdr.checking-import', version: 1, parserVersion: 'synthetic@1',
    account: { institution, type: 'checking', last4, label: 'Synthetic checking', currency: 'USD' },
    segments: [{
      source: 'ofx', coverage, anchors: [],
      rows: [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([postedDate, amountMinor, description]) => ({ postedDate, amountMinor, description, checkNumber: null, bankType: amountMinor < 0 ? 'DEBIT' : 'CREDIT', externalIdHash: null })),
    }],
  };
}

/**
 * Two Chase cards, each paid twice before by its own autopay, then one amount paid to both three days apart (settled by
 * the payer references). Two Amex payments of one card, day and amount, paid by a Fifth Third debit and a Wells Fargo
 * retry (interchangeable rows). One more Amex payment on a card with nothing after it, and nothing to pay it. With
 * `returned`, the original Wells Fargo pull of the Amex group and a Chase autopay each came back unpaid.
 */
function seed(target: string, options: { reject?: boolean; returned?: boolean; cameBack?: boolean; answer?: boolean; issuer?: string; amexTexts?: [string, string] } = {}) {
  const repo = new SqliteStateRepo({ file: target, now: () => NOW });
  try {
    const card = (issuer: string, last4: string) => repo.createCardAccount({ issuer, owner: 'alex', last4, currency: 'USD' });
    const chaseA = card('chase', '0031');
    const chaseB = card('chase', '0032');
    const amex = card('amex', '0041');
    const oldAmex = card(options.issuer ?? 'amex', '0042');
    const coverage = { start: '2025-01-01', end: '2026-10-15' };
    const imp = (id: string, rows: CardImportRow[], source = 'test-sync') =>
      repo.importCardTransactions({ cardAccountId: id, source, parserVersion: 'test@1', rows, coverage });
    imp(chaseA.id, [row({ transactionDate: '2026-03-05', amountMinor: -11_100 }), row({ transactionDate: '2026-04-05', amountMinor: -12_200 }),
      row({ transactionDate: '2026-09-10', amountMinor: -77_700 }), row({ transactionDate: '2026-06-10', amountMinor: -33_300 })]);
    imp(chaseB.id, [row({ transactionDate: '2026-03-08', amountMinor: -13_300 }), row({ transactionDate: '2026-04-08', amountMinor: -14_400 }),
      row({ transactionDate: '2026-09-13', amountMinor: -77_700 })]);
    imp(amex.id, [row({ transactionDate: '2026-08-21', amountMinor: -100_000, description: options.amexTexts?.[0] ?? 'ONLINE PAYMENT - THANK YOU' }),
      row({ transactionDate: '2026-08-21', amountMinor: -100_000, description: options.amexTexts?.[1] ?? 'ONLINE PAYMENT - THANK YOU' }),
      row({ transactionDate: '2026-09-30', amountMinor: 5_000, kind: 'purchase', description: 'SAMPLE BISTRO' })], 'amex-csv2026-10-99');
    imp(oldAmex.id, [row({ transactionDate: '2025-06-01', amountMinor: -42_000, description: 'ONLINE PAYMENT - THANK YOU' })]);
    const db = repo.internalGetDb();
    installCheckingSchema(db);
    const receipt = { now: NOW.toISOString(), goId: 'a'.repeat(32), purpose: 'copy-rehearsal' as const };
    importCheckingPayload(db, checking('wellsfargo', '0001', { start: '2025-01-01', end: '2026-10-15' }, [
      ['2026-03-05', -11_100, autopay('0001', 'SAMPLE HOLDER')], ['2026-04-06', -12_200, autopay('0001', 'SAMPLE HOLDER')],
      ['2026-03-09', -13_300, autopay('0002', 'OTHER HOLDER')], ['2026-04-08', -14_400, autopay('0002', 'OTHER HOLDER')],
      ['2026-09-11', -77_700, autopay('0001', 'SAMPLE HOLDER')], ['2026-09-14', -77_700, autopay('0002', 'OTHER HOLDER')],
      ['2026-06-10', -33_300, autopay('0001', 'SAMPLE HOLDER')],
      ['2026-08-25', -100_000, 'AMEX EPAYMENT RETRY PYMT 260825 W9999 SAMPLE HOLDER'],
      ...(options.returned ? [
        ['2026-08-24', -100_000, 'AMEX EPAYMENT ACH PMT 260824 W9999 SAMPLE HOLDER'], ['2026-08-24', 100_000, 'UNPAID ITEM RETURN'],
        ['2026-06-12', 33_300, 'RETURNED ITEM'],
      ] as Array<[string, number, string]> : []),
      ...(options.cameBack ? [
        ['2026-09-16', 77_700, 'ONLINE TRANSFER FROM SAMPLE SAVINGS'], ['2026-03-07', 11_100, 'ONLINE TRANSFER FROM SAMPLE SAVINGS'],
      ] as Array<[string, number, string]> : []),
      ...(options.answer ? [
        ['2025-06-02', -42_000, 'AMEX EPAYMENT ACH PMT 250602 W9999 SAMPLE HOLDER'], ['2025-06-03', -42_000, 'AMEX EPAYMENT ACH PMT 250603 W9999 SAMPLE HOLDER'],
      ] as Array<[string, number, string]> : []),
    ]), receipt);
    importCheckingPayload(db, checking('fifththird', '0002', { start: '2026-02-01', end: '2026-10-15' }, [
      ['2026-08-24', -100_000, 'WEB INITIATED PAYMENT AT AMEX EPAYMENT'],
    ]), receipt);
    installCardPaymentDecisionsSchema(db);
    if (options.reject) {
      const payment = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['payment'] })
        .find((item) => item.cardAccountId === chaseA.id && item.transactionDate === '2026-09-10')!;
      const debit = db.prepare(`SELECT id FROM checking_transactions WHERE posted_date = '2026-09-11'`).pluck().get() as string;
      repo.recordCardPaymentDecision({ decision: 'rejected', cardTransactionId: payment.id, checkingTransactionId: debit, amountMinor: -77_700, currency: 'USD', dayOffset: 1 }, OWNER);
    }
    if (options.answer) {
      // "Not this one" to one of the old Amex payment's two pulls, and the owner's confirmation of the Chase pull its bank
      // returned (with `returned`).
      const posted = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['payment'] });
      const debitOn = (date: string) => db.prepare('SELECT id FROM checking_transactions WHERE posted_date = ?').pluck().get(date) as string;
      const old = posted.find((item) => item.cardAccountId === oldAmex.id)!;
      repo.recordCardPaymentDecision({ decision: 'rejected', cardTransactionId: old.id, checkingTransactionId: debitOn('2025-06-02'), amountMinor: -42_000, currency: 'USD', dayOffset: 1 }, OWNER);
      const chase = posted.find((item) => item.cardAccountId === chaseA.id && item.transactionDate === '2026-06-10')!;
      repo.recordCardPaymentDecision({ decision: 'confirmed', cardTransactionId: chase.id, checkingTransactionId: debitOn('2026-06-10'), amountMinor: -33_300, currency: 'USD', dayOffset: 0 }, OWNER);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    repo.close();
  }
}

/**
 * Two payments on one Amex card a day apart, and Wells Fargo pulls of their amount that fit both: two, or one with
 * `elsewhere`. The owner rejects the first payment's pair with the first pull, then answers another of its rows: the
 * first payment paid by the second pull, or paid from another account (PR231-R1, Root 03:30Z).
 */
function seedAnswered(target: string, then: 'confirm' | 'elsewhere') {
  const repo = new SqliteStateRepo({ file: target, now: () => NOW });
  try {
    const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0051', currency: 'USD' });
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-01-01', end: '2026-10-15' },
      rows: [row({ transactionDate: '2026-05-01', amountMinor: -20_000 }), row({ transactionDate: '2026-05-02', amountMinor: -20_000 })],
    });
    const db = repo.internalGetDb();
    installCheckingSchema(db);
    const receipt = { now: NOW.toISOString(), goId: 'a'.repeat(32), purpose: 'copy-rehearsal' as const };
    importCheckingPayload(db, checking('wellsfargo', '0001', { start: '2026-01-01', end: '2026-10-15' }, [
      ['2026-05-02', -20_000, 'AMEX EPAYMENT ACH PMT 260502 W9999 SAMPLE HOLDER'],
      ...(then === 'confirm' ? [['2026-05-03', -20_000, 'AMEX EPAYMENT ACH PMT 260503 W9999 SAMPLE HOLDER']] as Array<[string, number, string]> : []),
    ]), receipt);
    installCardPaymentDecisionsSchema(db);
    const first = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['payment'] }).find((item) => item.transactionDate === '2026-05-01')!;
    const pull = (date: string) => db.prepare('SELECT id FROM checking_transactions WHERE posted_date = ?').pluck().get(date) as string;
    repo.recordCardPaymentDecision({ decision: 'rejected', cardTransactionId: first.id, checkingTransactionId: pull('2026-05-02'), amountMinor: -20_000, currency: 'USD', dayOffset: 1 }, OWNER);
    repo.recordCardPaymentDecision(then === 'confirm'
      ? { decision: 'confirmed', cardTransactionId: first.id, checkingTransactionId: pull('2026-05-03'), amountMinor: -20_000, currency: 'USD', dayOffset: 2 }
      : { decision: 'elsewhere', cardTransactionId: first.id, checkingTransactionId: null, amountMinor: -20_000, currency: 'USD' }, OWNER);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    repo.close();
  }
}

/**
 * 1f309a7f's two cases for the report's re-check of the owner's rejections (PR280-R4), each a pair the rules never read
 * as a candidate. `boundary`: a Wells Fargo payment the day of a Bilt debit from before Cardless issued the Bilt card,
 * which pays it as the Bilt card's carrier, and a Cardless Bilt payment four days on, which the owner said it did not
 * pay. `masked`: a Bilt debit making the Wells Fargo card the carrier; a later Bilt debit printing the number of the Bilt
 * card with history from then, which it pays; and the carrier's payment of its amount the next day, which the owner said
 * it did not pay.
 */
function seedBiltEra(target: string, variant: 'boundary' | 'masked') {
  const repo = new SqliteStateRepo({ file: target, now: () => NOW });
  try {
    const wf = repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0061', currency: 'USD' });
    const bilt = repo.createCardAccount({ issuer: 'bilt', owner: 'alex', last4: '0062', currency: 'USD' });
    const coverage = { start: '2025-01-01', end: '2026-10-15' };
    const imp = (id: string, rows: CardImportRow[]) =>
      repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage });
    const db = repo.internalGetDb();
    installCheckingSchema(db);
    const receipt = { now: NOW.toISOString(), goId: 'a'.repeat(32), purpose: 'copy-rehearsal' as const };
    const [paymentDate, debitDate] = variant === 'boundary' ? ['2026-02-08', '2026-02-04'] : ['2025-06-02', '2025-06-01'];
    if (variant === 'boundary') {
      imp(wf.id, [row({ transactionDate: '2026-02-04', amountMinor: -11_100 })]);
      imp(bilt.id, [row({ transactionDate: '2026-02-08', amountMinor: -11_100 })]);
      importCheckingPayload(db, checking('wellsfargo', '0001', coverage, [['2026-02-04', -11_100, 'BILT CARD PAYMENT 260204 SAMPLE HOLDER']]), receipt);
    } else {
      imp(wf.id, [row({ transactionDate: '2025-05-01', amountMinor: -22_200 }), row({ transactionDate: '2025-06-02', amountMinor: -11_100 })]);
      imp(bilt.id, [row({ transactionDate: '2025-06-01', amountMinor: -11_100 })]);
      importCheckingPayload(db, checking('wellsfargo', '0001', coverage, [
        ['2025-05-01', -22_200, 'BILT CARD PAYMENT 250501 SAMPLE HOLDER'],
        ['2025-06-01', -11_100, 'ONLINE TRANSFER REF #IBE9999999 TO BILT WORLD ELITE MASTERCARD XXXXXX0062 ON 99/99/99'],
      ]), receipt);
    }
    installCardPaymentDecisionsSchema(db);
    const rejected = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['payment'] })
      .find((item) => item.cardAccountId === (variant === 'boundary' ? bilt.id : wf.id) && item.transactionDate === paymentDate)!;
    const debit = db.prepare('SELECT id FROM checking_transactions WHERE posted_date = ?').pluck().get(debitDate) as string;
    repo.recordCardPaymentDecision({
      decision: 'rejected', cardTransactionId: rejected.id, checkingTransactionId: debit, amountMinor: -11_100, currency: 'USD',
      dayOffset: variant === 'boundary' ? -4 : -1,
    }, OWNER);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    repo.close();
  }
}

/**
 * Root's RECON-34 A and B: a Micro Center-like Wells Fargo card paid twice by Wells Fargo transfers naming its product
 * alone; and a Citi payment whose Fifth Third pull came back unpaid, then paid by the bank's retry six days after it.
 */
function seedProductAndRetry(target: string) {
  const repo = new SqliteStateRepo({ file: target, now: () => NOW });
  try {
    const coverage = { start: '2025-01-01', end: '2026-10-15' };
    const imp = (id: string, rows: CardImportRow[]) =>
      repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage });
    const retail = repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0071', currency: 'USD' });
    const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0072', currency: 'USD' });
    imp(retail.id, [row({ transactionDate: '2025-08-01', amountMinor: -11_100 }), row({ transactionDate: '2025-09-17', amountMinor: -22_200 })]);
    imp(citi.id, [row({ transactionDate: '2025-11-27', amountMinor: -50_000 })]);
    const db = repo.internalGetDb();
    installCheckingSchema(db);
    const receipt = { now: NOW.toISOString(), goId: 'a'.repeat(32), purpose: 'copy-rehearsal' as const };
    importCheckingPayload(db, checking('wellsfargo', '0001', coverage, [
      ['2025-08-03', -11_100, 'ONLINE TRANSFER TO MICRO CENTER'], ['2025-09-17', -22_200, 'ONLINE TRANSFER REF #IBE9999999 TO MICRO CENTER ON 99/99/99'],
    ]), receipt);
    importCheckingPayload(db, checking('fifththird', '0002', coverage, [
      ['2025-11-28', -50_000, 'CITI AUTOPAY PAYMENT ***9999 SAMPLE HOLDER'], ['2025-12-01', 50_000, 'UNPAID ITEM RETURN'],
      ['2025-12-03', -50_000, 'CITI AUTOPAY PAYMENT RETRY PYMT ***9999 SAMPLE HOLDER'],
    ]), receipt);
    installCardPaymentDecisionsSchema(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    repo.close();
  }
}

/** The report as the command builds it, on the database opened read-only. */
function report(target = file): PaymentReconciliationReport {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return paymentReconciliationReport(db);
  } finally {
    db.close();
  }
}

/** Every digit the line shows sits in a date, an account's last four or a count. */
function onlyAllowedDigits(line: string) {
  const stripped = line.replace(/"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.\.[0-9]{4}-[0-9]{2}-[0-9]{2})?"/g, '""')
    .replace(/"[a-z-]+:(?:[0-9]{4}|----)"/g, '""').replace(/:-?[0-9]+(?=[,}\]])/g, ':0').replace(/[[,]-?[0-9]+(?=[,\]])/g, ',0');
  expect(stripped.replace(/:0|,0/g, '')).not.toMatch(/[0-9]/);
}

beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('payment-reconciliation-report-');
  file = path.join(dir, 'finance.db');
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await removeScratchDir(dir);
});

describe('the dry run report', () => {
  it('reconciles read-only under this build\'s rules and says what became of every group held for the owner', () => {
    seed(file);
    const before = fs.readFileSync(file);
    const body = report();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(body).toMatchObject({
      code: 'payment-reconciliation-report', rulesVersion: 6, referenceProofs: 2,
      readings: { biltCarrier: 0, productCarriers: 0, retries: 0 },
      checking: { installed: true, accounts: [
        { account: 'fifththird:0002', coverage: ['2026-02-01..2026-10-15'] },
        { account: 'wellsfargo:0001', coverage: ['2025-01-01..2026-10-15'] },
      ] },
      decisions: { installed: true, inForce: {}, stale: 0 },
      held: {
        before: { groups: 2, payments: 4, debits: 4 }, after: { groups: 0, payments: 0, debits: 0 },
        outcomes: { interchangeable: 1, reference: 1 }, pairs: { interchangeable: 2, reference: 2 }, leftoverPayments: 0, leftoverDebits: 0,
        cameBackHolds: { groups: 0, payments: 0 },
      },
      withheld: { total: 0, answered: 0, returned: 0, reread: 0 },
      returnedPulls: { netted: 0, held: 0 },
      confirmed: { total: 0, returnedDebit: 0, list: [] },
      conflicts: { total: 0 },
      references: { identifyingOneCard: 2, provenOnceOnly: 0, tiedToSeveralCards: 0 },
      unmatchedPayments: {
        total: 1, byReason: { 'no-checking-debit': 1 }, byIssuer: { amex: 1 }, amex: { total: 1, noLaterCardActivity: 1, cardClosed: 0 },
        list: [{
          card: 'amex:0042', date: '2025-06-01', reason: 'no-checking-debit', coveredBy: ['wellsfargo:0001'], notCoveredBy: ['fifththird:0002'],
          cardStatus: 'active', lastCardActivity: '2025-06-01', laterCardActivity: false, offered: [], reversalsOffered: 0,
          sameAmountDebitsNearby: 0, leftFromAHeldGroup: false,
        }],
      },
      unmatchedDebits: { total: 0, byReads: {} },
    });
    expect(body.totals).toEqual([{
      currency: 'usd',
      payments: { all: 10, matched: 9, confirmed: 0, ambiguous: 0, unmatched: 1, elsewhere: 0, returned: 0, pending: 0 },
      debits: { all: 9, matched: 9, confirmed: 0, ambiguous: 0, unmatched: 0, notCardPayment: 0, biltHousing: 0, returned: 0 },
    }]);
    const [amexGroup, chaseGroup] = body.held.groups;
    expect(amexGroup).toEqual({
      group: 1, outcome: 'interchangeable',
      payments: [
        { card: 'amex:0041', date: '2026-08-21', posted: null, kind: 'payment', cue: 'online' },
        { card: 'amex:0041', date: '2026-08-21', posted: null, kind: 'payment', cue: 'online' },
      ],
      debits: [
        { account: 'fifththird:0002', date: '2026-08-24', reads: 'card-payment:amex', cue: 'online', hasReference: false, proofs: [], retry: false, cameBack: false, cameBackUnpaid: false },
        { account: 'wellsfargo:0001', date: '2026-08-25', reads: 'card-payment:amex', cue: null, hasReference: true, proofs: [], retry: true, cameBack: false, cameBackUnpaid: false },
      ],
      settled: [
        { card: 'amex:0041', paymentDate: '2026-08-21', account: 'fifththird:0002', date: '2026-08-24', reads: 'card-payment:amex', dayOffset: 3, basis: 'interchangeable', payments: 2, pairedBy: 'order' },
        { card: 'amex:0041', paymentDate: '2026-08-21', account: 'wellsfargo:0001', date: '2026-08-25', reads: 'card-payment:amex', dayOffset: 4, basis: 'interchangeable', payments: 2, pairedBy: 'order' },
      ],
      leftover: { payments: [], debits: [], stillHeld: [] },
      // A source slug shows as letters and hyphens only: its digits never print.
      sameCardAndDay: [{ card: 'amex:0041', date: '2026-08-21', rows: 2, sources: ['amex-csv'], batches: 1, keys: { fingerprint: 2 }, sameText: true, samePostedDate: true }],
      around: { credits: [], otherDebits: [] },
    });
    expect(chaseGroup).toMatchObject({
      group: 2, outcome: 'reference', notInterchangeable: 'cards',
      debits: [
        { account: 'wellsfargo:0001', date: '2026-09-11', hasReference: true, proofs: [{ card: 'chase:0031', proofs: 3 }], retry: false },
        { account: 'wellsfargo:0001', date: '2026-09-14', hasReference: true, proofs: [{ card: 'chase:0032', proofs: 2 }], retry: false },
      ],
      settled: [
        { card: 'chase:0031', paymentDate: '2026-09-10', date: '2026-09-11', basis: 'reference', proofs: 3 },
        { card: 'chase:0032', paymentDate: '2026-09-13', date: '2026-09-14', basis: 'reference', proofs: 2 },
      ],
      sameCardAndDay: [],
    });
    // Value-free: no amount, description, name, reference, id or path; digits only in counts, dates and last fours.
    const line = formatPaymentReconciliationReport(body)!;
    expect(line).not.toBeNull();
    for (const text of ['77700', '100000', 'SAMPLE', 'HOLDER', 'AUTOPAY', 'THANK', 'W9999', '9999', 'card-txn-', 'chk-txn-', 'chk-acct-', 'usr_', dir]) {
      expect(line).not.toContain(text);
    }
    onlyAllowedDigits(line);
  });

  it('holds a group the owner answered in full, never moving its debits (PR231-R1)', () => {
    seed(file, { reject: true });
    const body = report();
    expect(body.held).toMatchObject({
      before: { groups: 2, payments: 4, debits: 4 }, after: { groups: 1, payments: 2, debits: 2 },
      outcomes: { interchangeable: 1, 'held:answered': 1 }, pairs: { interchangeable: 2 },
    });
    expect(body.decisions.inForce).toEqual({ rejected: 1 });
    expect(body.held.groups[1]).toMatchObject({ outcome: 'held', held: 'answered', settled: [], leftover: { stillHeld: [{ payments: 2, debits: 2 }] } });
    expect(body.withheld).toEqual({ total: 0, answered: 0, returned: 0, reread: 0 });
    expect(body.unmatchedPayments.list.map((item) => item.card)).toEqual(['amex:0042']);
    expect(body.conflicts.total).toBe(0);
    expect(formatPaymentReconciliationReport(body)).not.toBeNull();
  });

  it('nets a pull its bank returned unpaid with its return, never pairs one, and counts the match this withholds (Root 02:32Z)', () => {
    seed(file, { returned: true });
    const body = report();
    expect(body.returnedPulls).toEqual({ netted: 2, held: 0 });
    expect(body.withheld).toEqual({ total: 1, answered: 0, returned: 1, reread: 0 });
    // The Amex group is read without the returned original pull: interchangeable rows, as before.
    expect(body.held.groups[0]).toMatchObject({ outcome: 'interchangeable', around: { credits: [{ account: 'wellsfargo:0001', date: '2026-08-24', returnedItem: true }] } });
    expect(body.totals[0].debits).toMatchObject({ returned: 2 });
    expect(body.unmatchedPayments.list.map((item) => [item.card, item.date])).toEqual([['amex:0042', '2025-06-01'], ['chase:0031', '2026-06-10']]);
    expect(body.conflicts.total).toBe(0);
    expect(formatPaymentReconciliationReport(body)).not.toBeNull();
  });

  it('holds a group whose pull came back by a credit of its amount in other words: the rules cannot tell it from a return', () => {
    seed(file, { cameBack: true });
    const body = report();
    expect(body.held).toMatchObject({
      after: { groups: 1, payments: 2, debits: 2 },
      outcomes: { interchangeable: 1, 'held:came-back': 1 }, pairs: { interchangeable: 2 },
    });
    // Both Chase pulls came back by a transfer of their amount, and so did one of the first card's three proven pulls,
    // which still pairs one to one but proves nothing: that reference shows two proofs.
    expect(body.held.groups[1]).toMatchObject({
      outcome: 'held', held: 'came-back', settled: [],
      debits: [
        { cameBack: true, cameBackUnpaid: false, proofs: [{ card: 'chase:0031', proofs: 2 }] },
        { cameBack: true, cameBackUnpaid: false, proofs: [{ card: 'chase:0032', proofs: 2 }] },
      ],
      around: { credits: [{ account: 'wellsfargo:0001', date: '2026-09-16', returnedItem: false }] },
    });
    expect(body.totals[0].debits).toMatchObject({ matched: 7, ambiguous: 2, returned: 0 });
    expect(body.held.cameBackHolds).toEqual({ groups: 1, payments: 2 });
    expect([body.withheld, body.returnedPulls]).toEqual([{ total: 0, answered: 0, returned: 0, reread: 0 }, { netted: 0, held: 0 }]);
    expect(body.conflicts.total).toBe(0);
    expect(formatPaymentReconciliationReport(body)).not.toBeNull();
  });

  it('counts the owner\'s confirmations of a pull returned unpaid, which stand, and the matches an answer withholds (Root 03:22Z, 03:28Z)', () => {
    seed(file, { returned: true, answer: true });
    const body = report();
    expect(body.decisions.inForce).toEqual({ confirmed: 1, rejected: 1 });
    // The owner confirmed the Chase pull its bank returned: the pair stands, and is counted and listed for the owner. It
    // proves no reference: that card's reference keeps its two other proofs.
    expect(body.confirmed).toEqual({
      total: 1, returnedDebit: 1,
      list: [{ card: 'chase:0031', paymentDate: '2026-06-10', account: 'wellsfargo:0001', date: '2026-06-10', returnedOn: '2026-06-12' }],
    });
    expect(body.totals[0].payments).toMatchObject({ confirmed: 1 });
    expect(body.held.groups.find((group) => group.outcome === 'reference')).toMatchObject({ debits: [{ proofs: [{ card: 'chase:0031', proofs: 2 }] }, {}] });
    // The old Amex payment had two pulls, and the owner said "not this one" to one: rules version 3 matched the other,
    // this build leaves the group to the owner.
    expect(body.withheld).toEqual({ total: 1, answered: 1, returned: 0, reread: 0 });
    expect(body.held).toMatchObject({ outcomes: { interchangeable: 1, reference: 1, 'held:answered': 1 }, cameBackHolds: { groups: 0, payments: 0 } });
    expect([body.returnedPulls, body.unmatchedPayments.total, body.unmatchedDebits.total]).toEqual([{ netted: 1, held: 0 }, 0, 1]);
    expect(body.conflicts.total).toBe(0);
    const line = formatPaymentReconciliationReport(body)!;
    expect(line).not.toBeNull();
    onlyAllowedDigits(line);
  });

  it('keeps a rejected pull with the owner while the owner answers the group\'s other rows (PR231-R1, Root 03:30Z)', () => {
    for (const then of ['confirm', 'elsewhere'] as const) {
      const target = path.join(dir, `answered-${then}.db`);
      seedAnswered(target, then);
      const body = report(target);
      // The rejected pull and the second payment wait for the owner: no pair the rules made touches a rejected row.
      expect(body.held, then).toMatchObject({ after: { groups: 1, payments: 1, debits: 1 }, outcomes: { 'held:answered': 1 } });
      expect(body.totals[0].payments, then).toMatchObject({ matched: 0, ambiguous: 1, confirmed: then === 'confirm' ? 1 : 0, elsewhere: then === 'elsewhere' ? 1 : 0 });
      expect(body.withheld, then).toEqual({ total: 1, answered: 1, returned: 0, reread: 0 });
      // A confirmed pull that stood is counted, never listed as returned.
      expect(body.confirmed, then).toEqual({ total: then === 'confirm' ? 1 : 0, returnedDebit: 0, list: [] });
      expect(body.conflicts, then).toMatchObject({ total: 0, autoPairOnRejectedRows: 0 });
      expect(formatPaymentReconciliationReport(body), then).not.toBeNull();
    }
  });

  it('re-checks the owner\'s rejections by the rules\' own test of a pair: the day Cardless issued the Bilt card, masked numbers (PR280-R4)', () => {
    for (const variant of ['boundary', 'masked'] as const) {
      const target = path.join(dir, `bilt-era-${variant}.db`);
      seedBiltEra(target, variant);
      const body = report(target);
      // The Bilt debit pays the Wells Fargo card as the Bilt card's carrier (masked, the Bilt card its number names too).
      // The pair the owner rejected was never a candidate: it holds nothing, and no pair the rules made is counted against it.
      expect(body.decisions.inForce, variant).toEqual({ rejected: 1 });
      expect(body.totals[0].payments, variant).toMatchObject({ matched: variant === 'boundary' ? 1 : 2, ambiguous: 0 });
      expect(body.held.before, variant).toEqual({ groups: 0, payments: 0, debits: 0 });
      expect(body.conflicts, variant).toMatchObject({ total: 0, autoPairOnRejectedRows: 0 });
      expect(body.unmatchedPayments.list.map((item) => [item.card, item.date]), variant)
        .toEqual([variant === 'boundary' ? ['bilt:0062', '2026-02-08'] : ['wellsfargo:0061', '2025-06-02']]);
      expect(formatPaymentReconciliationReport(body), variant).not.toBeNull();
    }
  });

  it('reads a product named alone by the card that carries it, and a retry in its returned pull\'s place (RECON-34 A, B)', () => {
    const target = path.join(dir, 'product-and-retry.db');
    seedProductAndRetry(target);
    const body = report(target);
    expect(body.rulesVersion).toBe(6);
    // One product's carrier found, and one retry standing in for its pull: every payment is paid, one to one.
    expect(body.readings).toEqual({ biltCarrier: 0, productCarriers: 1, retries: 1 });
    expect(body.totals[0].payments).toMatchObject({ matched: 3, ambiguous: 0 });
    expect([body.unmatchedPayments.total, body.unmatchedDebits.total]).toEqual([0, 0]);
    // The pull its bank returned nets with its return; version 3 paired it, so it is withheld as returned, as before.
    expect([body.returnedPulls, body.withheld]).toEqual([{ netted: 1, held: 0 }, { total: 1, answered: 0, returned: 1, reread: 0 }]);
    expect(body.conflicts.total).toBe(0);
    const line = formatPaymentReconciliationReport(body)!;
    expect(line).not.toBeNull();
    onlyAllowedDigits(line);
  });

  it('settles payments of one card and day whose descriptions differ, a clear cue choosing the pair; holds a reversal-kind row (Root 04:24Z)', () => {
    seed(file, { amexTexts: ['AUTOPAY PAYMENT - THANK YOU', 'ONLINE PAYMENT - THANK YOU'] });
    const body = report();
    const [amexGroup] = body.held.groups;
    expect(amexGroup).toMatchObject({ outcome: 'interchangeable', sameCardAndDay: [{ rows: 2, sameText: false }] });
    expect(amexGroup.payments.map((item) => [item.kind, item.cue]).sort()).toEqual([['payment', 'auto'], ['payment', 'online']]);
    expect(amexGroup.debits.map((item) => [item.account, item.cue])).toEqual([['fifththird:0002', 'online'], ['wellsfargo:0001', null]]);
    // The Fifth Third web payment and the payment made online share ONLINE: that pair is the cue's; the retry pays the
    // other, in canonical order. The report's own re-check finds each cue pair naming one channel on both sides.
    expect(amexGroup.settled.map((item) => [item.account, (item as { pairedBy?: string }).pairedBy]).sort()).toEqual([['fifththird:0002', 'cue'], ['wellsfargo:0001', 'order']]);
    expect(body.conflicts).toMatchObject({ total: 0, interchangeGroupNotIdentical: 0, interchangeCueNotShared: 0 });
    expect(formatPaymentReconciliationReport(body)).not.toBeNull();
    // A reversal-kind row the same day, or one never paid (PR231-R4), reads as no ordinary card payment: no
    // interchangeable rows, the group is held.
    for (const [index, text] of ['PAYMENT REVERSAL', 'UNPAID PAYMENT'].entries()) {
      const reversed = path.join(dir, `reversed-${index}.db`);
      seed(reversed, { amexTexts: [text, 'ONLINE PAYMENT - THANK YOU'] });
      const held = report(reversed);
      expect(held.held.groups[0], text).toMatchObject({ outcome: 'held', held: 'unproven', notInterchangeable: 'kinds', settled: [] });
      expect(held.held.groups[0].payments.map((item) => [item.kind, item.cue]).sort(), text).toEqual([['payment', 'online'], ['reversal', null]]);
      expect(held.conflicts.total, text).toBe(0);
      expect(formatPaymentReconciliationReport(held), text).not.toBeNull();
    }
  });

  it('prints an issuer, bank or source slug as letters and hyphens only, however it was named (PR231-R3)', () => {
    seed(file, { issuer: 'samplebank1234-5678' });
    const body = report();
    expect(body.unmatchedPayments.list.map((item) => item.card)).toEqual(['samplebank:0042']);
    expect(body.unmatchedPayments.byIssuer).toEqual({ samplebank: 1 });
    const line = formatPaymentReconciliationReport(body)!;
    expect(line).not.toBeNull();
    expect(line).not.toMatch(/1234|5678|2026-10-99/);
    onlyAllowedDigits(line);
    for (const [text, expected] of [['samplebank1234-5678', 'samplebank'], ['1234-5678', 'other'], ['wells--fargo-', 'wells-fargo'], [42, 'other'],
      ['A-VERY-LONG-ISSUER-NAME-INDEED', 'a-very-long-issu']] as const) {
      expect(reportWord(text, 'other'), String(text)).toBe(expected);
    }
  });

  it('prints nothing outside its strict schema: digits only in counts, dates and account last fours', () => {
    seed(file);
    const body = report();
    expect(formatPaymentReconciliationReport(body)).not.toBeNull();
    const patched = (patch: (copy: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      patch(copy);
      return formatPaymentReconciliationReport(copy as unknown as PaymentReconciliationReport);
    };
    const groupOf = (copy: Record<string, unknown>) => (copy.held as { groups: Array<Record<string, unknown>> }).groups[0];
    for (const [name, patch] of [
      ['an unknown key', (copy) => { copy.description = 'x'; }],
      ['an amount', (copy) => { groupOf(copy).amountMinor = -1; }],
      ['a label with more digits', (copy) => { groupOf(copy).payments = [{ card: 'samplebank1234-5678:0042', date: '2026-08-21', posted: null }]; }],
      ['digits in a word', (copy) => { groupOf(copy).outcome = 'held1234'; }],
      ['a date that is no date', (copy) => { groupOf(copy).payments = [{ card: 'amex:0041', date: '12345678', posted: null }]; }],
      ['a count of more than five digits', (copy) => { copy.rulesVersion = 123_456; }],
      ['a counted key with digits', (copy) => { (copy.unmatchedPayments as { byIssuer: Record<string, number> }).byIssuer = { bank1234: 1 }; }],
      ['a fraction', (copy) => { copy.referenceProofs = 2.5; }],
    ] as Array<[string, (copy: Record<string, unknown>) => void]>) {
      expect(patched(patch), name).toBeNull();
    }
  });

  it('refuses a decisions table in another shape, before reading anything', () => {
    seed(file);
    const db = new Database(file);
    try {
      db.exec('DROP INDEX card_payment_decisions_rejected');
    } finally {
      db.close();
    }
    expect(() => report()).toThrow(new HoldrRefusal(REPORT_CONFLICT));
  });
});

describe('holdr-payment-reconciliation report', () => {
  it('refuses to run without the writer\'s shared lease, and unknown arguments', async () => {
    seed(file);
    const before = fs.readFileSync(file);
    expect(await run(['report', '--db', file])).toBe(1);
    expect(stderr).toBe('payment-reconciliation: report-refused no-shared-lease\n');
    expect(stdout).toBe('');
    stderr = '';
    for (const args of [['report'], ['report', '--db', 'finance.db'], ['report', '--db', file, '--db', file], ['report', '--db', file, '--out', file]]) {
      expect(await run(args)).toBe(1);
    }
    expect(stderr).toBe('payment-reconciliation: input-refused HoldrRefusal\n'.repeat(4));
    expect(stdout).toBe('');
    expect(fs.readFileSync(file)).toEqual(before);
  });
});

describe.skipIf(process.platform !== 'darwin')('holdr-payment-reconciliation report under the shared lease', { timeout: 60_000 }, () => {
  it('prints the report under the lease, read-only; refuses while the lifecycle lock is held exclusively, or a decisions table in another shape', async () => {
    const control = await controlEnvFixture({ machine: FAKE_MACHINE });
    cleanups.push(control.cleanup);
    const target = path.join(control.dataDir, 'finance.db');
    seed(target);
    const before = fs.readFileSync(target);
    expect(await run(['report', '--db', target], control.env)).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ code: 'payment-reconciliation-report', conflicts: { total: 0 } });
    expect(fs.readFileSync(target)).toEqual(before);
    stdout = '';
    await lockHolder(lockPath(control.controlDir, LIFECYCLE_LOCK), 'exclusive', cleanups);
    expect(await run(['report', '--db', target], control.env)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('operation-failed');
    for (const cleanup of cleanups.splice(1)) cleanup();
    stderr = '';
    const db = new Database(target);
    try {
      db.exec('DROP INDEX card_payment_decisions_rejected');
    } finally {
      db.close();
    }
    expect(await run(['report', '--db', target], control.env)).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ code: 'payment-reconciliation-conflict', schema: 'conflict' });
  });
});
