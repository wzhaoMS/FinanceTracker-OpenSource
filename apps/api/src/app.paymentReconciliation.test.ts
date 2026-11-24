import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

import type { ReconciliationCheckingRow } from '@finance-tracker/shared';
import { createApp } from './app.js';
import { createCardPaymentReconciliationRouter, type CheckingLedgerReader } from './routes/cardPaymentReconciliation.js';
import { mountCardSpendingRoutes } from './routes/cardSpending.js';
import { installCardPaymentDecisionsSchema } from './services/cardPaymentDecisions.js';
import { importCheckingPayload } from './services/checking/importer.js';
import { installCheckingSchema } from './services/checking/schema.js';
import { SqliteStateRepo, type CardImportRow } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';

/**
 * Card payment reconciliation as the real app serves it (createApp): every response that existed before it is
 * byte-identical with and without a checking ledger, and with and without the owner's answers; its own routes cut every
 * number they show to its last four. Synthetic data only: made-up descriptors, amounts, ids and dates.
 */

const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '5e'.repeat(32);
const NOW = new Date('2026-10-16T12:00:00.000Z');
const OWNER = { actorRef: `usr_${'e'.repeat(32)}` };
const WF = `chk-acct-${'a'.repeat(32)}`;
const ACCOUNT_NUMBER = 'PAYMENT FROM CHECKING ACCOUNT 1234567890';

let repo: SqliteStateRepo;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  repo = new SqliteStateRepo({ file: ':memory:', now: () => NOW });
});

afterEach(() => {
  vi.useRealTimers();
  repo.close();
});

function chk(n: number): string {
  return `chk-txn-${n.toString(16).padStart(32, '0').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))}`;
}

function debit(n: number, date: string, amountMinor: number, description: string): ReconciliationCheckingRow {
  return { id: chk(n), checkingAccountId: WF, date, status: 'posted', amountMinor, currency: 'USD', description };
}

function ledger(rows: ReconciliationCheckingRow[]): CheckingLedgerReader {
  return {
    installed: () => true,
    listAccounts: () => [{ id: WF, institution: 'wellsfargo', label: 'Sample Bank Everyday Checking', last4: '0001', currency: 'USD', status: 'active' }],
    listRows: ({ from, to }) => rows.filter((row) => row.date >= from && row.date <= to),
    coverage: () => [{ checkingAccountId: WF, ranges: [{ start: '2025-10-01', end: '2026-10-15' }] }],
  };
}

function row(patch: Partial<CardImportRow>): CardImportRow {
  return {
    transactionDate: '2026-09-10', postedDate: null, status: 'posted', amountMinor: -10_000, currency: 'USD',
    kind: 'payment', description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

function seed() {
  const coverage = { start: '2026-01-01', end: '2026-10-15' };
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0011', currency: 'USD' });
  const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0022', currency: 'USD' });
  repo.importCardTransactions({
    cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row({ transactionDate: '2026-09-25', amountMinor: -50_000 }),
      row({ transactionDate: '2026-07-10', amountMinor: -30_000, description: 'ONLINE PAYMENT THANK YOU' }),
      row({ transactionDate: '2026-09-02', amountMinor: 12_345, kind: 'purchase', description: 'SAMPLE BISTRO' }),
      row({ transactionDate: '2026-10-12', amountMinor: -7_000, status: 'pending', description: 'PAYMENT PENDING' }),
    ],
  });
  repo.importCardTransactions({
    cardAccountId: citi.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row({ transactionDate: '2026-07-11', amountMinor: -30_000, description: ACCOUNT_NUMBER }),
      row({ transactionDate: '2026-06-15', amountMinor: -9_999, description: 'ONLINE PAYMENT, THANK YOU' }),
      row({ transactionDate: '2026-08-08', amountMinor: 4_500, kind: 'purchase', description: 'SAMPLE GROCER' }),
    ],
  });
  const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
  const find = (amountMinor: number) => all.find((item) => item.amountMinor === amountMinor)!.id;
  return {
    ids: {
      amexSep: find(-50_000), amexJul: all.find((item) => item.cardAccountId === amex.id && item.amountMinor === -30_000)!.id,
      citiJul: all.find((item) => item.cardAccountId === citi.id && item.amountMinor === -30_000)!.id, citiJun: find(-9_999),
      pending: find(-7_000), bistro: find(12_345), grocer: find(4_500),
    },
    debits: [
      debit(1, '2026-09-26', -50_000, 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER'),
      debit(7, '2026-07-11', -30_000, 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER'),
      debit(8, '2026-07-12', -30_000, 'CITI AUTOPAY PAYMENT ***9999 SAMPLE HOLDER'),
      debit(11, '2026-06-16', -9_999, 'ONLINE TRANSFER REF #IBE9999999 TO SAMPLE SAVINGS XXXXXX9999 ON 99/99/99'),
    ],
  };
}

function app(checkingLedger?: CheckingLedgerReader): Express {
  return createApp({
    repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, log: () => {},
    ...(checkingLedger ? { checkingLedger } : {}),
  }).app;
}

/** A local script on the loopback port with the service token: every card spending read is open to it. */
async function read(server: Express, url: string) {
  return request(await listenLoopback(server)).get(url).set('Authorization', ['Bearer', TOKEN].join(' '));
}

/** Every existing card spending read, as status and the exact bytes of its body. */
async function existingResponses(server: Express, ids: Record<string, string>) {
  const urls = [
    '/card-accounts', '/card-transactions?limit=200', '/card-transactions?kind=payment', '/card-transactions?status=posted',
    ...Object.values(ids).flatMap((id) => [`/card-transactions/${id}`, `/card-transactions/${id}?categoryBasis=enriched`]),
    '/spending/summary', '/spending/summary?from=2026-07-01&to=2026-09-30', '/spending/accounting',
    '/spending/insights?month=2026-09&today=2026-10-16', '/spending/coverage', '/spending/coverage/months',
    '/spending/compare?from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&today=2026-10-16',
    '/spending/trend', '/spending/benefits', '/card-imports/cutover-capability',
  ];
  const answers: Array<[string, number, string]> = [];
  for (const url of urls) {
    const res = await read(server, url);
    answers.push([url, res.status, res.text]);
  }
  return answers;
}

/** Runs of five or more digits, counted across the separators numbers are written with. */
function longDigitRuns(text: string): string[] {
  return (text.match(/\p{N}+(?:[\s\p{Pd}./\\,_|'·∙⋅]+\p{N}+)*/gu) ?? []).filter((run) => run.replace(/[^\p{N}]/gu, '').length >= 5);
}

describe('card payment reconciliation in the real app', () => {
  it('leaves every existing response byte-identical, with and without a checking ledger and the owner\'s answers', async () => {
    const { ids, debits } = seed();
    const before = await existingResponses(app(), ids);
    expect(before.filter(([, status]) => status !== 200).map(([url, status]) => `${status} ${url}`)).toEqual([]);
    expect(await existingResponses(app(ledger(debits)), ids)).toEqual(before);

    installCardPaymentDecisionsSchema(repo.internalGetDb());
    repo.recordCardPaymentDecision({ decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(7), amountMinor: -30_000, currency: 'USD', dayOffset: 1 }, OWNER);
    repo.recordCardPaymentDecision({ decision: 'elsewhere', cardTransactionId: ids.citiJun, checkingTransactionId: null, amountMinor: -9_999, currency: 'USD' }, OWNER);
    repo.recordCardPaymentDecision({ decision: 'not-card-payment', cardTransactionId: null, checkingTransactionId: chk(11), amountMinor: -9_999, currency: 'USD' }, OWNER);
    const decided = app(ledger(debits));
    expect(await existingResponses(decided, ids)).toEqual(before);
    expect(await existingResponses(app(), ids)).toEqual(before);
    for (const [, , text] of before) expect(text).not.toContain('paymentMatch');

    // The reconciliation's own reads show the decided state, every number cut to its last four.
    const reconciliation = await read(decided, '/spending/payment-reconciliation');
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body.pairs.map((pair: { payment: { id: string }; status: string }) => [pair.payment.id, pair.status])).toEqual([
      [ids.amexJul, 'confirmed'], [ids.citiJul, 'matched'], [ids.amexSep, 'matched'],
    ]);
    const citi = reconciliation.body.pairs.find((pair: { payment: { id: string } }) => pair.payment.id === ids.citiJul);
    expect(citi.payment.description).toBe('PAYMENT FROM CHECKING ACCOUNT ***7890');
    const standing = await read(decided, `/spending/payment-reconciliation/payments/${ids.citiJul}`);
    expect(standing.body.paymentMatch).toEqual(expect.objectContaining({ status: 'matched', debit: expect.objectContaining({ id: chk(8), descriptor: 'CITI AUTOPAY PAYMENT ***9999 SAMPLE HOLDER' }) }));
    for (const text of [reconciliation.text, standing.text]) {
      expect(text).not.toContain('1234567890');
      for (const [, shown] of text.matchAll(/"(?:description|descriptor)":"((?:[^"\\]|\\.)*)"/g)) expect(longDigitRuns(shown)).toEqual([]);
    }
  });

  it('reads the checking import\'s own ledger when no reader is passed, from the moment its tables are installed', async () => {
    const { ids } = seed();
    const server = app();
    const before = await existingResponses(server, ids);
    const empty = await read(server, '/spending/payment-reconciliation');
    expect([empty.status, empty.body.checking.installed, empty.body.pairs]).toEqual([200, false, []]);
    // Until then it answers exactly as no reader at all did: the same bytes as the reconciliation router given none.
    const bare = express();
    mountCardSpendingRoutes(bare, {
      repo, log: () => {},
      requireAuth: (req, _res, next) => { req.holdrAuth = { kind: 'service' }; next(); },
      routers: [createCardPaymentReconciliationRouter(repo, { log: () => {}, checkingLedger: null })],
    });
    for (const url of ['/spending/payment-reconciliation', `/spending/payment-reconciliation/payments/${ids.amexSep}`]) {
      const withReader = await read(server, url);
      const withNone = await request(await listenLoopback(bare)).get(url);
      expect([withReader.status, withReader.text], url).toEqual([withNone.status, withNone.text]);
    }

    // The checking import's own tables and importer, as its operator command runs them; the app already running reads them.
    const db = repo.internalGetDb();
    installCheckingSchema(db);
    const receipt = importCheckingPayload(db, {
      format: 'holdr.checking-import', version: 1, parserVersion: 'synthetic@1',
      account: { institution: 'wellsfargo', type: 'checking', last4: '0001', label: 'Synthetic checking', currency: 'USD' },
      segments: [{
        source: 'ofx', coverage: { start: '2026-09-01', end: '2026-09-30' }, anchors: [],
        rows: [{ postedDate: '2026-09-26', amountMinor: -50_000, description: 'AMEX EPAYMENT ACH PMT SAMPLE HOLDER', checkNumber: null, bankType: 'DEBIT', externalIdHash: null }],
      }],
    }, { now: NOW.toISOString(), goId: 'a'.repeat(32), purpose: 'copy-rehearsal' });
    expect(receipt).toEqual(expect.objectContaining({ code: 'checking-imported', rowsNew: 1 }));

    const body = (await read(server, '/spending/payment-reconciliation')).body;
    expect([body.checking.installed, body.checking.accounts.length]).toEqual([true, 1]);
    expect(body.pairs.map((pair: { payment: { id: string }; status: string; debit: { descriptor: string } }) => [pair.payment.id, pair.status, pair.debit.descriptor]))
      .toEqual([[ids.amexSep, 'matched', 'AMEX EPAYMENT ACH PMT SAMPLE HOLDER']]);
    // Every existing response stays byte-identical.
    expect(await existingResponses(server, ids)).toEqual(before);
  });
});
