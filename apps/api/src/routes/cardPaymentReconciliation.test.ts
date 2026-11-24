import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cardImportTextProblem, sanitizeCardText, type ReconciliationCheckingRow } from '@finance-tracker/shared';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import {
  createCardPaymentReconciliationRouter,
  maskedDescriptor,
  type CheckingLedgerReader,
} from './cardPaymentReconciliation.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { CARD_PAYMENT_DECISIONS_CONFLICT, CARD_PAYMENT_DECISIONS_NOT_INSTALLED, installCardPaymentDecisionsSchema } from '../services/cardPaymentDecisions.js';
import { listenLoopback } from '../testing/loopback.js';

// Card payments against the checking debits that paid them, end to end. Synthetic data only: fictional descriptors in
// the shapes banks print (every digit a 9, a made-up holder), made-up amounts, ids, last-4s and account names.

let dir: string;
let repo: SqliteStateRepo;
let logs: string[];

const testAuth: RequestHandler = (req, res, next) => {
  if (req.headers['x-test-auth'] === 'ok') {
    req.holdrAuth = { kind: 'session', userId: 'test-owner', username: 'test-owner', sessionId: 'test-session' };
    return next();
  }
  if (req.headers['x-test-auth'] === 'service') {
    req.holdrAuth = { kind: 'service' };
    return next();
  }
  res.status(401).json({ error: 'sign in' });
};

const WF = `chk-acct-${'a'.repeat(32)}`;
const FIFTH = `chk-acct-${'b'.repeat(32)}`;
const COVERED = { start: '2023-10-01', end: '2026-10-15' };
const AMEX = 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER';
const CITI = 'CITI AUTOPAY PAYMENT 999999 ***9999 SAMPLE HOLDER';
const CHASE = 'CHASE CREDIT CRD EPAY 999999 ***9999 SAMPLE HOLDER';
const BILT = 'BILT CARD PAYMENT 999999 SAMPLE HOLDER';
const BILT_RENT = 'BILT RENT ACH DEBIT 999999 SAMPLE HOLDER';
const GENERIC = 'CREDIT CARD PAYMENT 999999';
const CITIZENS = 'BILL PAY CITIZENS CREDIT CARD 999999';
const DISCOVER = 'DISCOVER E-PAYMENT 999999 9999 SAMPLE HOLDER';
const SAVINGS = 'ONLINE TRANSFER REF #IBE9999999 TO SAMPLE SAVINGS XXXXXX9999 ON 99/99/99';
const ACCOUNT_NUMBER = 'PAYMENT FROM CHECKING ACCOUNT 1234567890';

/** Runs of five or more digits, counted across the separators numbers are written with: none may be shown. */
function longDigitRuns(text: string): string[] {
  return (text.match(/\p{N}+(?:[\s\p{Pd}./\\,_|'·∙⋅]+\p{N}+)*/gu) ?? []).filter((run) => run.replace(/[^\p{N}]/gu, '').length >= 5);
}

/** Every description and descriptor an answer shows. */
function shownTexts(body: unknown): string[] {
  return [...JSON.stringify(body).matchAll(/"(?:description|descriptor)":"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string);
}

/** A checking row id in the checking ledger's grammar, from a small number. */
function chk(n: number): string {
  return `chk-txn-${n.toString(16).padStart(32, '0').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))}`;
}

function debit(n: number, date: string, amountMinor: number, description: string, account = WF): ReconciliationCheckingRow {
  return { id: chk(n), checkingAccountId: account, date, status: 'posted', amountMinor, currency: 'USD', description };
}

function checkingLedger(rows: ReconciliationCheckingRow[], options: { installed?: boolean; label?: string; institution?: string } = {}): CheckingLedgerReader {
  return {
    installed: () => options.installed ?? true,
    listAccounts: () => [
      { id: WF, institution: options.institution ?? 'wellsfargo', label: options.label ?? 'Sample Bank Everyday Checking', last4: '0001', currency: 'USD', status: 'active' },
      { id: FIFTH, institution: 'fifththird', label: 'Sample Fifth Checking', last4: '0002', currency: 'USD', status: 'active' },
    ],
    listRows: ({ from, to }) => rows.filter((row) => row.date >= from && row.date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1)),
    coverage: () => [{ checkingAccountId: WF, ranges: [COVERED] }, { checkingAccountId: FIFTH, ranges: [COVERED] }],
  };
}

function buildApp(ledger: CheckingLedgerReader | null): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log }), createCardPaymentReconciliationRouter(repo, { log, checkingLedger: ledger })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-payment-reconciliation-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(logs.join('\n')).not.toMatch(/\d{13}/);
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function row(patch: Partial<CardImportRow>): CardImportRow {
  return {
    transactionDate: '2026-09-10', postedDate: null, status: 'posted', amountMinor: -10_000, currency: 'USD',
    kind: 'payment', description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

const CARD_ROWS = {
  amex: [
    row({ transactionDate: '2026-09-25', amountMinor: -50_000 }),
    row({ transactionDate: '2026-08-25', amountMinor: -42_110 }),
    row({ transactionDate: '2026-09-02', amountMinor: 12_345, kind: 'purchase', description: 'SAMPLE BISTRO' }),
    row({ transactionDate: '2026-10-12', amountMinor: -7_000, status: 'pending', description: 'PAYMENT PENDING' }),
    // Paid twice the same amount on close dates, as the second Amex card below, both debits naming Amex: the owner decides.
    row({ transactionDate: '2026-07-10', amountMinor: -30_000, description: 'ONLINE PAYMENT THANK YOU' }),
    // Before any checking history was imported.
    row({ transactionDate: '2023-03-03', amountMinor: -11_111, description: 'ONLINE PAYMENT THANK YOU' }),
  ],
  amex2: [row({ transactionDate: '2026-07-11', amountMinor: -30_000, description: 'ONLINE PAYMENT, THANK YOU' })],
  citi: [
    row({ transactionDate: '2026-09-26', amountMinor: -50_000, description: 'ONLINE PAYMENT, THANK YOU' }),
    // Nothing in checking pays this one: paid from elsewhere.
    row({ transactionDate: '2026-06-15', amountMinor: -9_999, description: 'ONLINE PAYMENT, THANK YOU' }),
  ],
  chase: [row({ transactionDate: '2026-09-05', amountMinor: -21_500, description: 'AUTOMATIC PAYMENT - THANK' })],
  bilt: [row({ transactionDate: '2026-10-01', amountMinor: -300_000, description: 'PAYMENT RECEIVED' })],
};

function seed() {
  const coverage = { start: '2023-01-01', end: '2026-10-15' };
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0011', currency: 'USD' });
  const amex2 = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0055', currency: 'USD' });
  const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0022', currency: 'USD' });
  const chase = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '0033', currency: 'USD' });
  const bilt = repo.createCardAccount({ issuer: 'bilt', owner: 'alex', last4: '0044', currency: 'USD' });
  const imp = (id: string, rows: CardImportRow[]) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage });
  imp(amex.id, CARD_ROWS.amex);
  imp(amex2.id, CARD_ROWS.amex2);
  imp(citi.id, CARD_ROWS.citi);
  imp(chase.id, CARD_ROWS.chase);
  imp(bilt.id, CARD_ROWS.bilt);
  const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] });
  const find = (cardAccountId: string, transactionDate: string) =>
    all.find((item) => item.cardAccountId === cardAccountId && item.transactionDate === transactionDate)!.id;
  const debits = [
    debit(1, '2026-09-26', -50_000, AMEX),
    debit(2, '2026-09-27', -50_000, CITI),
    debit(3, '2026-08-26', -42_110, AMEX, FIFTH),
    debit(4, '2026-09-06', -21_500, CHASE, FIFTH),
    debit(5, '2026-10-01', -300_000, BILT_RENT),
    debit(6, '2026-10-02', -300_000, BILT),
    debit(7, '2026-07-11', -30_000, AMEX),
    debit(8, '2026-07-12', -30_000, AMEX),
    debit(9, '2026-05-05', -4_000, DISCOVER),
    debit(10, '2026-04-04', -6_500, AMEX),
    debit(11, '2026-06-16', -9_999, SAVINGS),
    debit(12, '2026-03-03', -2_000, 'SAMPLE UTILITY BILL PAY 999999'),
  ];
  return {
    cards: { amex, amex2, citi, chase, bilt },
    ids: {
      amexSep: find(amex.id, '2026-09-25'), amexAug: find(amex.id, '2026-08-25'), amexJul: find(amex.id, '2026-07-10'),
      amexOld: find(amex.id, '2023-03-03'), amexPending: find(amex.id, '2026-10-12'), amexPurchase: find(amex.id, '2026-09-02'),
      amex2Jul: find(amex2.id, '2026-07-11'), citiSep: find(citi.id, '2026-09-26'), citiJun: find(citi.id, '2026-06-15'),
      chaseSep: find(chase.id, '2026-09-05'), biltOct: find(bilt.id, '2026-10-01'),
    },
    debits,
  };
}

const get = async (app: express.Express, url: string, auth = 'ok') => request(await listenLoopback(app)).get(url).set('x-test-auth', auth);
const send = async (app: express.Express, method: 'post' | 'delete', url: string, body?: unknown, auth = 'ok') => {
  const call = request(await listenLoopback(app))[method](url).set('x-test-auth', auth);
  return body === undefined ? call : call.set('content-type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
};
const reconciliation = async (app: express.Express) => {
  const res = await get(app, '/spending/payment-reconciliation');
  expect(res.status).toBe(200);
  return res.body;
};
const pairIds = (body: { pairs: Array<{ payment: { id: string }; debit: { id: string }; status: string }> }) =>
  body.pairs.map((pair) => [pair.payment.id, pair.debit.id, pair.status]);
const DECISIONS = '/spending/payment-reconciliation/decisions';

describe('GET /spending/payment-reconciliation', () => {
  it('without a checking ledger, leaves every payment unmatched for want of a checking account', async () => {
    const { ids } = seed();
    const app = buildApp(null);
    const body = await reconciliation(app);
    expect(body.checking).toEqual({ installed: false, accounts: [] });
    expect(body.decisions).toEqual({ installed: false, stale: [], answers: [] });
    expect(body.pairs).toEqual([]);
    expect(body.unmatchedPayments.map((item: { reason: string }) => item.reason)).toEqual(Array(9).fill('no-checking-account'));
    expect(body.totals).toEqual([expect.objectContaining({
      currency: 'USD',
      payments: expect.objectContaining({ all: { count: 9, amountMinor: -544_720 }, pending: { count: 1, amountMinor: -7_000 } }),
    })]);
    // A payment's detail is as it was: no paymentMatch, no checking source.
    const detail = await get(app, `/card-transactions/${ids.amexSep}`);
    expect(detail.body).not.toHaveProperty('paymentMatch');
    expect(detail.body.possiblyPaidFrom).toEqual([]);
    // An installed-but-empty ledger answers the same way, with its accounts.
    const empty = await reconciliation(buildApp(checkingLedger([], { installed: false })));
    expect(empty.checking.installed).toBe(false);
  });

  it('matches every payment one to one across Wells Fargo and Fifth Third, and shows both sides with why', async () => {
    const { ids, debits } = seed();
    const body = await reconciliation(buildApp(checkingLedger(debits)));
    expect(body.rules).toEqual({ daysBefore: 5, daysAfter: 5, confirmDays: 15, returnDays: 30 });
    expect(body.checking).toEqual({
      installed: true,
      accounts: [
        { id: WF, label: 'Sample Bank Everyday Checking', institution: 'wellsfargo', last4: '0001', currency: 'USD', status: 'active', coverage: [COVERED] },
        { id: FIFTH, label: 'Sample Fifth Checking', institution: 'fifththird', last4: '0002', currency: 'USD', status: 'active', coverage: [COVERED] },
      ],
    });
    expect(pairIds(body)).toEqual([
      [ids.amexAug, chk(3), 'matched'],
      [ids.chaseSep, chk(4), 'matched'],
      [ids.amexSep, chk(1), 'matched'],
      [ids.citiSep, chk(2), 'matched'],
      [ids.biltOct, chk(6), 'matched'],
    ]);
    const amexPair = body.pairs[2];
    expect(amexPair).toEqual({
      status: 'matched', dayOffset: 1,
      payment: { id: ids.amexSep, cardAccountId: expect.any(String), date: '2026-09-25', amountMinor: -50_000, currency: 'USD', description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU' },
      debit: {
        id: chk(1), checkingAccountId: WF, accountLabel: 'Sample Bank Everyday Checking', date: '2026-09-26', amountMinor: -50_000,
        currency: 'USD', class: 'card-payment', payee: 'amex', payeeLabel: 'American Express',
        descriptor: 'AMEX EPAYMENT ACH PMT ***9999 W9999 SAMPLE HOLDER',
      },
    });
    // Two Amex cards paid the same amount a day apart, by debits naming Amex: one group, for the owner.
    expect(body.ambiguous).toHaveLength(1);
    expect(body.ambiguous[0].payments.map((item: { id: string }) => item.id)).toEqual([ids.amexJul, ids.amex2Jul]);
    expect(body.ambiguous[0].debits.map((item: { id: string }) => item.id)).toEqual([chk(7), chk(8)]);
    expect(body.unmatchedPayments.map((item: { payment: { id: string }; reason: string }) => [item.payment.id, item.reason])).toEqual([
      [ids.amexOld, 'checking-not-covered'],
      [ids.citiJun, 'no-checking-debit'],
    ]);
    // The transfer to savings of the same amount is offered, never matched.
    expect(body.unmatchedPayments[1].possibleDebits).toEqual([{ dayOffset: 1, debit: expect.objectContaining({ id: chk(11), class: 'other', payee: null }) }]);
    expect(body.unmatchedDebits.map((item: { debit: { id: string; payee: string }; reason: string }) => [item.debit.id, item.debit.payee, item.reason])).toEqual([
      [chk(10), 'amex', 'no-card-payment'],
      [chk(9), 'discover', 'no-card-account'],
    ]);
    // The Bilt rent pull of the Bilt Pay-card payment's very amount pays no Pay-card payment: held out, never a gap.
    expect(body.biltHousing.map((item: { debit: { id: string; class: string; payee: string }; reason: string }) =>
      [item.debit.id, item.debit.class, item.debit.payee, item.reason])).toEqual([[chk(5), 'bilt-housing', 'bilt', 'no-card-payment']]);
    expect(body.totals).toEqual([{
      currency: 'USD',
      payments: {
        all: { count: 9, amountMinor: -544_720 }, matched: { count: 5, amountMinor: -463_610 }, confirmed: { count: 0, amountMinor: 0 },
        ambiguous: { count: 2, amountMinor: -60_000 }, unmatched: { count: 2, amountMinor: -21_110 }, elsewhere: { count: 0, amountMinor: 0 },
        returned: { count: 0, amountMinor: 0 }, pending: { count: 1, amountMinor: -7_000 },
      },
      debits: {
        all: { count: 9, amountMinor: -534_110 }, matched: { count: 5, amountMinor: -463_610 }, confirmed: { count: 0, amountMinor: 0 },
        ambiguous: { count: 2, amountMinor: -60_000 }, unmatched: { count: 2, amountMinor: -10_500 },
        notCardPayment: { count: 0, amountMinor: 0 }, biltHousing: { count: 1, amountMinor: -300_000 }, returned: { count: 0, amountMinor: 0 },
      },
    }]);
    // Every text shown keeps at most the last four digits of any number.
    const shown = shownTexts(body);
    expect(shown.length).toBeGreaterThan(10);
    for (const text of shown) expect(longDigitRuns(text)).toEqual([]);
  });

  it('shows a text only with every number cut to its last four, never one with a hidden character, and labels only without digits', async () => {
    expect(maskedDescriptor(ACCOUNT_NUMBER)).toBe('PAYMENT FROM CHECKING ACCOUNT ***7890');
    expect(maskedDescriptor('AMEX EPAYMENT ACH PMT 123456 W1234 SAMPLE HOLDER')).toBe('AMEX EPAYMENT ACH PMT ***3456 W1234 SAMPLE HOLDER');
    expect(maskedDescriptor('DISCOVER E-PAYMENT 123456 7890 SAMPLE HOLDER')).toBe('DISCOVER E-PAYMENT ***7890 SAMPLE HOLDER');
    expect(maskedDescriptor('CARD PAYMENT 4111 1111 1111 1111')).toBe('CARD PAYMENT ***1111');
    expect(maskedDescriptor('CARD PAYMENT 4111.1111.1111.1111')).toBe('CARD PAYMENT ***1111');
    expect(maskedDescriptor('ACCOUNT 1234/5678/9012')).toBe('ACCOUNT ***9012');
    expect(maskedDescriptor('ＣＡＲＤ ４１１１１１１１１１１１１１１１ ①')).toBe('CARD ***1111');
    expect(maskedDescriptor('REF 1234 W5678')).toBe('REF 1234 W5678');
    // Two masked numbers side by side would read as one card number: no digit of either is shown.
    expect(maskedDescriptor('CITI CARD ONLINE PAYMENT 123456 ***1234 SAMPLE HOLDER')).toBe('CITI CARD ONLINE PAYMENT ***#### ***#### SAMPLE HOLDER');
    expect(maskedDescriptor('PAYMENT\u200b123')).toBeUndefined();
    expect(maskedDescriptor(42)).toBeUndefined();
    expect(maskedDescriptor('A'.repeat(200))).toHaveLength(120);
    const { debits } = seed();
    const body = await reconciliation(buildApp(checkingLedger([...debits, debit(20, '2026-02-02', -1_234, 'CHASE CREDIT CRD 4111 1111 1111 1111')], { label: 'Checking 1234' })));
    expect(body.checking.accounts[0].label).toBe('Checking account');
    // An institution slug with a number in it, even split up, is not shown.
    for (const institution of ['bank-1234-5678', 'bank12345', 'Bank']) {
      const shown = await reconciliation(buildApp(checkingLedger([], { institution })));
      expect(shown.checking.accounts[0].institution).toBe('other');
    }
    const masked = body.unmatchedDebits.find((item: { debit: { id: string } }) => item.debit.id === chk(20));
    expect(masked.debit.descriptor).toBe('CHASE CREDIT CRD ***1111');
    expect(masked.debit.payee).toBe('chase');
    expect(JSON.stringify(body)).not.toContain('4111');
  });

  it('masks every card payment description on every list and answer, the 10-digit account number included', async () => {
    const { cards, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    repo.importCardTransactions({
      cardAccountId: cards.citi.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-05-01', end: '2026-10-15' },
      rows: [
        row({ transactionDate: '2026-05-20', amountMinor: -7_777, description: ACCOUNT_NUMBER }),
        row({ transactionDate: '2026-05-22', amountMinor: -6_666, description: ACCOUNT_NUMBER }),
        row({ transactionDate: '2026-05-24', amountMinor: -5_555, description: ACCOUNT_NUMBER }),
      ],
    });
    const stored = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['payment'] });
    const id = (amountMinor: number) => stored.find((item) => item.amountMinor === amountMinor)!.id;
    // The importer keeps the ten digits: only what this answers shows is masked.
    expect(stored.find((item) => item.amountMinor === -7_777)!.description).toBe(ACCOUNT_NUMBER);
    const app = buildApp(checkingLedger([...debits, debit(40, '2026-05-21', -7_777, CITI), debit(42, '2026-05-25', -5_555, SAVINGS)]));
    const rejected = await send(app, 'post', DECISIONS, { decision: 'rejected', cardTransactionId: id(-5_555), checkingTransactionId: chk(42) });
    expect(rejected.status).toBe(201);
    const body = await reconciliation(app);
    const masked = 'PAYMENT FROM CHECKING ACCOUNT ***7890';
    expect(body.pairs.find((pair: { payment: { id: string } }) => pair.payment.id === id(-7_777)).payment.description).toBe(masked);
    const unmatched = (paymentId: string) => body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === paymentId);
    expect(unmatched(id(-6_666)).payment.description).toBe(masked);
    expect(body.decisions.answers).toEqual([expect.objectContaining({ decision: 'rejected', payment: expect.objectContaining({ id: id(-5_555), description: masked }) })]);
    for (const text of [JSON.stringify(body), (await get(app, `/spending/payment-reconciliation/payments/${id(-7_777)}`)).text]) {
      expect(text).not.toContain('1234567890');
      expect(text).not.toContain('34567890');
    }
    for (const text of shownTexts(body)) expect(longDigitRuns(text)).toEqual([]);
  });

  it('matches a Bilt housing payment row with its same-day housing pull, apart from the Pay-card payment beside it', async () => {
    const { cards, ids, debits } = seed();
    repo.importCardTransactions({
      cardAccountId: cards.bilt.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-10-15' },
      rows: [row({ transactionDate: '2026-10-01', amountMinor: -300_000, description: 'HOUSING PAYMENT SAMPLE SERVICER', issuerCategory: 'Housing payment' })],
    });
    const housingRow = repo.listCardTransactionsMatching({ statuses: ['posted'] })
      .find((item) => item.issuerCategory === 'Housing payment')!.id;
    const body = await reconciliation(buildApp(checkingLedger(debits)));
    // Same amount, a day apart, one Bilt card: the housing pull pays the housing row, the Pay-card debit the Pay-card payment.
    expect(pairIds(body)).toEqual(expect.arrayContaining([[housingRow, chk(5), 'matched'], [ids.biltOct, chk(6), 'matched']]));
    expect(body.biltHousing).toEqual([]);
    expect(body.ambiguous).toHaveLength(1);
  });

  it('refuses every answer across the Bilt lanes with a 400 and writes nothing', async () => {
    const { cards, ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    repo.importCardTransactions({
      cardAccountId: cards.bilt.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-10-15' },
      rows: [row({ transactionDate: '2026-10-01', amountMinor: -300_000, description: 'HOUSING PAYMENT SAMPLE SERVICER', issuerCategory: 'Housing payment' })],
    });
    const housingRow = repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((item) => item.issuerCategory === 'Housing payment')!.id;
    // A housing pull and an ordinary Bilt debit of one amount on the very day of both payments.
    const app = buildApp(checkingLedger([
      ...debits.filter((item) => item.id !== chk(5) && item.id !== chk(6)),
      debit(50, '2026-10-01', -300_000, BILT_RENT), debit(51, '2026-10-01', -300_000, BILT),
      debit(53, '2026-10-01', -300_000, 'SAMPLE UTILITY BILL PAY'), debit(54, '2026-10-01', -300_000, GENERIC),
    ]));
    const stored = () => repo.internalGetDb().prepare('SELECT count(*) AS n FROM card_payment_decisions').get();
    const crossed: Array<[string, string, string]> = [
      ['confirmed', ids.biltOct, chk(50)], ['confirmed', housingRow, chk(51)], ['rejected', ids.biltOct, chk(50)], ['rejected', housingRow, chk(51)],
      // A housing row with a debit that reads as no card payment, or names no issuer: refused as well.
      ['confirmed', housingRow, chk(53)], ['confirmed', housingRow, chk(54)],
    ];
    for (const [decision, cardTransactionId, checkingTransactionId] of crossed) {
      const res = await send(app, 'post', DECISIONS, { decision, cardTransactionId, checkingTransactionId });
      expect([res.status, res.body.error], `${decision} ${cardTransactionId === housingRow ? 'housing row' : 'Pay-card'} ${checkingTransactionId}`).toEqual([
        400, 'a Bilt housing pull pays only a Bilt housing payment, and a Bilt housing payment is paid only by a Bilt housing pull',
      ]);
    }
    expect(stored()).toEqual({ n: 0 });
    // The rules pair each lane with its own.
    expect(pairIds(await reconciliation(app))).toEqual(expect.arrayContaining([[housingRow, chk(50), 'matched'], [ids.biltOct, chk(51), 'matched']]));
  });

  it('never offers a pair across the Bilt lanes: a row whose own lane has no counterpart is a gap with its reason', async () => {
    const { cards, ids } = seed();
    repo.importCardTransactions({
      cardAccountId: cards.bilt.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-10-15' },
      rows: [row({ transactionDate: '2026-09-15', amountMinor: -300_000, description: 'HOUSING PAYMENT SAMPLE SERVICER', issuerCategory: 'Housing payment' })],
    });
    const housingRow = repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((item) => item.issuerCategory === 'Housing payment')!.id;
    // Each payment has only the other lane's debit in its window.
    const body = await reconciliation(buildApp(checkingLedger([debit(52, '2026-09-15', -300_000, BILT), debit(53, '2026-10-01', -300_000, BILT_RENT)])));
    expect(body.pairs).toEqual([]);
    const gap = (id: string) => body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === id);
    expect([gap(housingRow).reason, gap(housingRow).possibleDebits]).toEqual(['no-checking-debit', []]);
    expect([gap(ids.biltOct).reason, gap(ids.biltOct).possibleDebits]).toEqual(['no-checking-debit', []]);
    expect(body.unmatchedDebits.map((item: { debit: { id: string }; reason: string; possiblePayments: unknown[] }) => [item.debit.id, item.reason, item.possiblePayments]))
      .toEqual([[chk(52), 'no-card-payment', []]]);
    expect(body.biltHousing.map((item: { debit: { id: string }; reason: string; possiblePayments: unknown[] }) => [item.debit.id, item.reason, item.possiblePayments]))
      .toEqual([[chk(53), 'no-card-payment', []]]);
  });

  it('never matches a bill pay naming a payee it does not know by itself, only offers it', async () => {
    const { ids } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    // The Citi payment Holdr has no debit for, and a Citizens bill pay of its amount the next day.
    const app = buildApp(checkingLedger([debit(60, '2026-06-16', -9_999, CITIZENS)]));
    const body = await reconciliation(app);
    expect(body.pairs).toEqual([]);
    const payment = body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === ids.citiJun);
    expect(payment.possibleDebits).toEqual([{ dayOffset: 1, debit: expect.objectContaining({ id: chk(60), class: 'card-payment', payee: 'unrecognized', payeeLabel: 'Unrecognized issuer' }) }]);
    expect(body.unmatchedDebits).toEqual([expect.objectContaining({ debit: expect.objectContaining({ id: chk(60) }), reason: 'no-card-payment' })]);
    // The owner may say it paid the Citi card.
    expect((await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.citiJun, checkingTransactionId: chk(60) })).status).toBe(201);
    expect(pairIds(await reconciliation(app))).toEqual([[ids.citiJun, chk(60), 'confirmed']]);
  });

  it('never matches a descriptor with anything but printable ASCII, or a name split by punctuation or a word, kept as the converter stores it; a product alone pays the card that carries it', async () => {
    // Each descriptor through the checking converter's text pipeline (the card text sanitizer, then its check).
    const stored = (raw: string) => {
      const text = sanitizeCardText(raw, 200)!;
      expect([text, cardImportTextProblem(text, 200)], raw).toEqual([raw, null]);
      return text;
    };
    const cases: Array<[string, string, boolean]> = [
      ['citi', 'CITIÉ CARD PAYMENT 999999', false], ['amex', 'ÉAMEX CARD PAYMENT 999999', false],
      ['capitalone', 'CAPITAL 银行 ONE CARD PAYMENT 999999', false], ['amex', 'AMERICAN 银行 EXPRESS CARD PAYMENT 999999', false],
      ['wellsfargo', 'WELLS 银行 FARGO CARD PAYMENT 999999', false], ['usbank', 'US 银行 BANK CARD PAYMENT 999999', false],
      // Root 03:56Z: a symbol anywhere, or a name split by punctuation, names no issuer.
      ['capitalone', 'CAPITAL 💰 ONE CARD PAYMENT 999999', false], ['capitalone', 'CAPITAL € ONE CARD PAYMENT 999999', false],
      ['wellsfargo', 'WELLS © FARGO CARD PAYMENT 999999', false], ['usbank', 'US \uFFFD BANK CARD PAYMENT 999999', false],
      ['amex', 'AMEX EPAYMENT ACH PMT 999999 ©', false],
      ['capitalone', 'CAPITAL+ONE MOBILE PMT 999999', false], ['capitalone', 'CAPITAL-ONE MOBILE PMT 999999', false],
      ['capitalone', 'CAPITAL,ONE MOBILE PMT 999999', false],
      // Root 03:59Z: a card's product alone names no issuer. Root (RECON-34 A): it pays the one Wells Fargo card the rows
      // show carries that product, here the only one paid its amount close by.
      ['wellsfargo', 'ONLINE TRANSFER TO MICRO CENTER', true],
      // ASCII controls: another word between an alias's words, a digit in its token; then the exact aliases.
      ['capitalone', 'CAPITAL BANK ONE CARD PAYMENT 999999', false], ['citi', 'CITI1 CARD PAYMENT 999999', false],
      ['citi', 'CITI CARD PAYMENT 999999', true], ['capitalone', 'CAPITAL ONE CARD PAYMENT 999999', true],
      ['capitalone', 'CAPITAL ONE-MOBILE PMT 999999', true], ['citi', 'CITI-CARD ONLINE PAYMENT 999999', true],
      ['wellsfargo', 'ONLINE TRANSFER TO WELLS FARGO MICRO CENTER', true],
    ];
    const cards = new Map<string, string>();
    const coverage = { start: '2026-01-01', end: '2026-10-15' };
    const payments: string[] = [];
    for (const [index, [issuer]] of cases.entries()) {
      if (!cards.has(issuer)) cards.set(issuer, repo.createCardAccount({ issuer, owner: 'alex', last4: String(5184 + cards.size), currency: 'USD' }).id);
      const batch = repo.importCardTransactions({
        cardAccountId: cards.get(issuer)!, source: 'test-sync', parserVersion: 'test@1', coverage,
        rows: [row({ transactionDate: '2026-06-01', amountMinor: -(1_101 + index) })],
      });
      expect(batch.newCount).toBe(1);
      payments.push(repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((item) => item.amountMinor === -(1_101 + index))!.id);
    }
    const body = await reconciliation(buildApp(checkingLedger(cases.map(([, raw], index) => debit(90 + index, '2026-06-02', -(1_101 + index), stored(raw))))));
    const exactPairs = cases.flatMap(([, , exact], index) => (exact ? [[payments[index], chk(90 + index), 'matched']] : []));
    expect(pairIds(body)).toHaveLength(exactPairs.length);
    expect(pairIds(body)).toEqual(expect.arrayContaining(exactPairs));
    for (const [index, [, raw, exact]] of cases.entries()) {
      if (exact) continue;
      const left = body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === payments[index]);
      expect(left.possibleDebits.map((option: { debit: { id: string } }) => option.debit.id), raw).toEqual([chk(90 + index)]);
    }
  });

  it('keeps the Bilt lanes by whole tokens in every card field as imported, and refuses a crossed answer without writing', async () => {
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const kept = (raw: string) => {
      const text = sanitizeCardText(raw, 200)!;
      expect([text, cardImportTextProblem(text, 200)], raw).toEqual([raw, null]);
      return text;
    };
    const bilt = repo.createCardAccount({ issuer: 'bilt', owner: 'alex', last4: '0044', currency: 'USD' });
    // 1f309a7f's four cases (HOUSINGÉ in each field, beside a housing pull or an ordinary Bilt debit), then plain controls.
    const cases: Array<{ patch: Partial<CardImportRow>; debit: string; expected: 'refused' | 'owner' | 'matched' }> = [
      { patch: { description: kept('PAY CARD HOUSINGÉ'), issuerCategory: 'Payments' }, debit: BILT_RENT, expected: 'refused' },
      { patch: { description: kept('PAY CARD HOUSINGÉ'), issuerCategory: 'Payments' }, debit: BILT, expected: 'owner' },
      { patch: { description: 'PAY CARD', merchant: kept('HOUSINGÉ'), issuerCategory: 'Payments' }, debit: BILT_RENT, expected: 'refused' },
      { patch: { description: 'PAY CARD', issuerCategory: kept('HOUSINGÉ') }, debit: BILT_RENT, expected: 'refused' },
      { patch: { description: 'PAY CARD HOUSING', issuerCategory: 'Payments' }, debit: BILT_RENT, expected: 'matched' },
      { patch: { description: 'PAY CARD HOUSING', issuerCategory: 'Payments' }, debit: BILT, expected: 'refused' },
      { patch: { description: 'PAY CARD', issuerCategory: 'Payments' }, debit: BILT, expected: 'matched' },
      { patch: { description: 'PAY CARD', issuerCategory: 'Payments' }, debit: BILT_RENT, expected: 'refused' },
    ];
    const amount = (index: number) => -(10_000 + index);
    repo.importCardTransactions({
      cardAccountId: bilt.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-01-01', end: '2026-10-15' },
      rows: cases.map((item, index) => row({ transactionDate: '2026-06-01', amountMinor: amount(index), ...item.patch })),
    });
    const stored = repo.listCardTransactionsMatching({ statuses: ['posted'] });
    const payments = cases.map((item, index) => {
      const found = stored.find((entry) => entry.amountMinor === amount(index))!;
      // As stored: the text exactly as sent.
      expect([found.description, found.merchant ?? null, found.issuerCategory ?? null])
        .toEqual([item.patch.description, item.patch.merchant ?? null, item.patch.issuerCategory ?? null]);
      return found.id;
    });
    const app = buildApp(checkingLedger(cases.map((item, index) => debit(70 + index, '2026-06-01', amount(index), item.debit))));
    const body = await reconciliation(app);
    for (const [index, item] of cases.entries()) {
      const label = `${index} ${JSON.stringify(item.patch)} with ${item.debit}`;
      const pair = [payments[index], chk(70 + index)];
      const group = body.ambiguous.find((entry: { payments: Array<{ id: string }> }) => entry.payments.some((payment) => payment.id === payments[index]));
      const left = body.unmatchedPayments.find((entry: { payment: { id: string } }) => entry.payment.id === payments[index]);
      if (item.expected === 'matched') expect(pairIds(body), label).toContainEqual([...pair, 'matched']);
      if (item.expected === 'owner') {
        expect(pairIds(body).some(([id]) => id === payments[index]), label).toBe(false);
        expect([group?.payments.map((payment: { id: string }) => payment.id), group?.debits.map((debit: { id: string }) => debit.id)], label).toEqual([[pair[0]], [pair[1]]]);
      }
      if (item.expected === 'refused') {
        expect([pairIds(body).some(([id]) => id === payments[index]), group, left?.possibleDebits], label).toEqual([false, undefined, []]);
        const res = await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: pair[0], checkingTransactionId: pair[1] });
        expect([res.status, res.body.error], label).toEqual([
          400, 'a Bilt housing pull pays only a Bilt housing payment, and a Bilt housing payment is paid only by a Bilt housing pull',
        ]);
      }
    }
    const written = () => repo.internalGetDb().prepare('SELECT count(*) AS n FROM card_payment_decisions').get();
    expect(written()).toEqual({ n: 0 });
    // The owner may confirm the HOUSINGÉ row's own-lane debit.
    expect((await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: payments[1], checkingTransactionId: chk(71) })).status).toBe(201);
    expect(written()).toEqual({ n: 1 });
    expect(pairIds(await reconciliation(app))).toContainEqual([payments[1], chk(71), 'confirmed']);
  });

  it('never matches a payment with anything but printable ASCII in its own text, nor a same-issuer payment beside it', async () => {
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const kept = (raw: string) => {
      const text = sanitizeCardText(raw, 200)!;
      expect([text, cardImportTextProblem(text, 200)], raw).toEqual([raw, null]);
      return text;
    };
    const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0011', currency: 'USD' });
    const amex2 = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0055', currency: 'USD' });
    const coverage = { start: '2026-01-01', end: '2026-10-15' };
    // One field at a time, each its own amount: description, merchant, category.
    const patches: Array<Partial<CardImportRow>> = [
      { description: kept('ONLINE PAYMENT 💳') }, { merchant: kept('Synthetic ©') }, { issuerCategory: kept('Payments €') },
      { description: 'ONLINE PAYMENT, THANK YOU', merchant: 'Synthetic (c)', issuerCategory: 'Payments' },
    ];
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', coverage,
      rows: [
        ...patches.map((patch, index) => row({ transactionDate: '2026-06-01', amountMinor: -(20_000 + index), ...patch })),
        // 1f309a7f: the same amount and day on both Amex cards, one with a symbol in its merchant; one Amex debit.
        row({ transactionDate: '2026-07-01', amountMinor: -25_000 }),
      ],
    });
    repo.importCardTransactions({
      cardAccountId: amex2.id, source: 'test-sync', parserVersion: 'test@1', coverage,
      rows: [row({ transactionDate: '2026-07-01', amountMinor: -25_000, merchant: kept('Synthetic ©') })],
    });
    const stored = repo.listCardTransactionsMatching({ statuses: ['posted'] });
    const idOf = (amountMinor: number, cardAccountId = amex.id) => stored.find((item) => item.amountMinor === amountMinor && item.cardAccountId === cardAccountId)!.id;
    const app = buildApp(checkingLedger([
      ...patches.map((_, index) => debit(80 + index, '2026-06-02', -(20_000 + index), AMEX)),
      debit(85, '2026-07-01', -25_000, AMEX),
    ]));
    const body = await reconciliation(app);
    const groups = body.ambiguous.map((group: { payments: Array<{ id: string }>; debits: Array<{ id: string }> }) =>
      [group.payments.map((payment) => payment.id), group.debits.map((debit) => debit.id)]);
    for (const index of [0, 1, 2]) expect(groups, String(index)).toContainEqual([[idOf(-(20_000 + index))], [chk(80 + index)]]);
    expect(pairIds(body)).toEqual([[idOf(-20_003), chk(83), 'matched']]);
    expect(groups).toContainEqual([[idOf(-25_000), idOf(-25_000, amex2.id)].sort(), [chk(85)]]);
    expect(groups).toHaveLength(4);
    // The owner says which.
    expect((await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: idOf(-20_001), checkingTransactionId: chk(81) })).status).toBe(201);
    expect(pairIds(await reconciliation(app))).toContainEqual([idOf(-20_001), chk(81), 'confirmed']);
  });

  it('hints when brokerage cash may have paid a payment with no checking debit, reading brokerage only', async () => {
    const { ids, debits } = seed();
    repo.createAccount({ id: 'brokerage-a', name: 'Sample Brokerage', cashBalance: 1000, currency: 'USD', accountNumber: 'Z7418763' });
    repo.insertCashEvent({
      accountId: 'brokerage-a', date: '2026-06-16', eventType: 'transfer', amount: -99.99, currency: 'USD', broker: 'fidelity',
      accountLast4: '8763', description: 'SAMPLE TRANSFER OUT', sourceFingerprint: 'e'.repeat(64),
    });
    const ledger = () => repo.internalGetDb().prepare('SELECT count(*) AS n FROM account_cash_events').get();
    const before = ledger();
    const body = await reconciliation(buildApp(checkingLedger(debits)));
    expect(body.unmatchedPayments.map((item: { payment: { id: string }; brokerageSuggestions: number }) =>
      [item.payment.id, item.brokerageSuggestions])).toEqual([[ids.amexOld, 0], [ids.citiJun, 1]]);
    expect(ledger()).toEqual(before);
    expect(JSON.stringify(body)).not.toContain('brokerage-a');
  });

  it('answers the value-free 500 when the checking ledger fails, quoting nothing', async () => {
    seed();
    const ledger = checkingLedger([]);
    ledger.listRows = () => { throw new Error('synthetic failure 4111 1111 1111 1111 SAMPLE SECRET'); };
    const res = await get(buildApp(ledger), '/spending/payment-reconciliation');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/SAMPLE|4111/);
    expect(logs.join('\n')).not.toMatch(/SAMPLE|4111/);
  });

  it('refuses query parameters and card data in the query', async () => {
    seed();
    const app = buildApp(checkingLedger([]));
    expect((await get(app, '/spending/payment-reconciliation?from=2026-01-01')).status).toBe(400);
    const card = await get(app, '/spending/payment-reconciliation?q=4111111111111111');
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
    expect((await get(app, '/spending/payment-reconciliation', 'nobody')).status).toBe(401);
    expect((await get(app, '/spending/payment-reconciliation', 'service')).status).toBe(200);
  });
});

describe('a masked card number, through the route', () => {
  it('names the card by the masked number a transfer prints, never by the checking account\'s own, and keeps the Bilt transition apart', async () => {
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    // Two Wells Fargo cards, one on record with the checking account's own ending (0001 here, as a bank's account list
    // may show it), and the Cardless Bilt card from its first day; every ending made up.
    const autograph = repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0066', currency: 'USD' });
    const retail = repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0077', currency: 'USD' });
    repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0001', currency: 'USD' });
    const cardless = repo.createCardAccount({ issuer: 'bilt', owner: 'alex', last4: '0088', currency: 'USD' });
    const imp = (cardAccountId: string, start: string, rows: CardImportRow[]) =>
      repo.importCardTransactions({ cardAccountId, source: 'test-sync', parserVersion: 'test@1', coverage: { start, end: '2026-10-15' }, rows });
    imp(autograph.id, '2025-01-01', [
      row({ transactionDate: '2026-07-01', amountMinor: -10_000 }),
      // The Wells Fargo-issued Bilt card's last payment, its history on this account.
      row({ transactionDate: '2026-02-04', amountMinor: -40_000, description: 'ONLINE PAYMENT THANK YOU' }),
      row({ transactionDate: '2026-09-10', amountMinor: -30_000, description: 'AUTOMATIC PAYMENT - THANK' }),
    ]);
    imp(retail.id, '2025-01-01', [row({ transactionDate: '2026-07-02', amountMinor: -10_000 })]);
    imp(cardless.id, '2026-02-07', [row({ transactionDate: '2026-02-08', amountMinor: -40_000, description: 'PAYMENT RECEIVED' })]);
    const stored = repo.listCardTransactionsMatching({ statuses: ['posted'] });
    const idOf = (cardAccountId: string, transactionDate: string) =>
      stored.find((item) => item.cardAccountId === cardAccountId && item.transactionDate === transactionDate)!.id;
    const app = buildApp(checkingLedger([
      debit(110, '2026-07-01', -10_000, 'ONLINE TRANSFER REF #IBE9999999 TO WELLS FARGO AUTOGRAPH VISA CARD XXXXXX0066 ON 99/99/99'),
      debit(111, '2026-07-02', -10_000, 'ONLINE TRANSFER REF #IBE9999999 TO MICRO CENTER CREDIT CARD XXXXXX0077 ON 99/99/99'),
      debit(112, '2026-02-04', -40_000, 'ONLINE TRANSFER REF #IBE9999999 TO BILT WORLD ELITE MASTERCARD XXXXXX0088 ON 99/99/99'),
      debit(113, '2026-09-10', -30_000, 'WF CREDIT CARD AUTO PAY XXXXXX0001 SAMPLE HOLDER'),
    ]));
    const body = await reconciliation(app);
    // Each transfer pairs with the card its number names (the product alone included); the payment printing the checking
    // account's own number pairs by its issuer, as before. The old Bilt card's transfer, printing the number the Cardless
    // card kept, pays the Wells Fargo account that carried the old card (RECON-34).
    expect(pairIds(body)).toEqual(expect.arrayContaining([
      [idOf(autograph.id, '2026-07-01'), chk(110), 'matched'], [idOf(retail.id, '2026-07-02'), chk(111), 'matched'],
      [idOf(autograph.id, '2026-09-10'), chk(113), 'matched'], [idOf(autograph.id, '2026-02-04'), chk(112), 'matched'],
    ]));
    expect(body.pairs).toHaveLength(4);
    expect(body.ambiguous).toEqual([]);
    // It never pays the Cardless card's first payment, which is left with nothing offered.
    const gap = (id: string) => body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === id);
    expect(body.unmatchedPayments).toHaveLength(1);
    expect(gap(idOf(cardless.id, '2026-02-08')).possibleDebits).toEqual([]);
    expect(body.unmatchedDebits).toEqual([]);
    // The owner may still confirm what the rules matched.
    const confirmed = await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: idOf(autograph.id, '2026-02-04'), checkingTransactionId: chk(112) });
    expect([confirmed.status, confirmed.body.decision.rulesVersion]).toEqual([201, 6]);
    expect(pairIds(await reconciliation(app))).toContainEqual([idOf(autograph.id, '2026-02-04'), chk(112), 'confirmed']);
  });

  it('never lets a card\'s product of several words split by punctuation name the card, kept as the converter stores it (PR193-R1)', async () => {
    const autograph = repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0066', currency: 'USD' });
    const retail = repo.createCardAccount({ issuer: 'wellsfargo', owner: 'alex', last4: '0077', currency: 'USD' });
    // Each case its own amount, paid the same day on both Wells Fargo cards; the transfer names the second by its number.
    const variants = ['MICRO CENTER', 'ACTIVE CASH'].flatMap((product) => ['+', '-', '/', '.', '_'].map((separator) => product.replace(' ', separator)));
    const controls = ['MICRO CENTER', 'MICRO\tCENTER', 'MICRO  CENTER', 'ACTIVE CASH'];
    const cases = [...variants.map((product) => [product, false] as const), ...controls.map((product) => [product, true] as const)];
    const amount = (index: number) => -(2_300 + index);
    for (const card of [autograph, retail]) {
      repo.importCardTransactions({
        cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-01-01', end: '2026-10-15' },
        rows: cases.map((_, index) => row({ transactionDate: '2026-09-01', amountMinor: amount(index) })),
      });
    }
    const stored = repo.listCardTransactionsMatching({ statuses: ['posted'] });
    const idOf = (cardAccountId: string, index: number) => stored.find((item) => item.cardAccountId === cardAccountId && item.amountMinor === amount(index))!.id;
    const debits = cases.map(([product], index) => {
      const text = sanitizeCardText(`ONLINE TRANSFER TO ${product} CARD XXXXXX0077`, 200)!;
      expect(cardImportTextProblem(text, 200), product).toBeNull();
      // The converter keeps the punctuation: what the rules read is what is stored.
      if (variants.includes(product)) expect(text, product).toContain(product);
      return debit(120 + index, '2026-09-01', amount(index), text);
    });
    const body = await reconciliation(buildApp(checkingLedger(debits)));
    for (const [index, [product, names]] of cases.entries()) {
      const pair = body.pairs.find((item: { debit: { id: string } }) => item.debit.id === chk(120 + index));
      const offered = (cardAccountId: string) => body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === idOf(cardAccountId, index))
        ?.possibleDebits.map((option: { debit: { id: string } }) => option.debit.id);
      if (names) {
        expect([pair?.payment.id, pair?.status], JSON.stringify(product)).toEqual([idOf(retail.id, index), 'matched']);
        expect(offered(autograph.id), JSON.stringify(product)).toEqual([]);
      } else {
        expect(pair, product).toBeUndefined();
        expect([offered(autograph.id), offered(retail.id)], product).toEqual([[chk(120 + index)], [chk(120 + index)]]);
      }
    }
    expect(body.ambiguous).toEqual([]);
  });
});

describe('a payment the card took back, through the route', () => {
  it('settles it with its reversal shown, matches the payment made again with its debit, and only offers a payment-worded charge', async () => {
    const { debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const coverage = { start: '2023-01-01', end: '2026-10-15' };
    const chase2 = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '0066', currency: 'USD' });
    const citi2 = repo.createCardAccount({ issuer: 'citi', owner: 'casey', last4: '0077', currency: 'USD' });
    const rows = {
      chase2: [
        row({ transactionDate: '2026-03-10', amountMinor: -40_000, description: 'AUTOMATIC PAYMENT - THANK' }),
        row({ transactionDate: '2026-03-13', amountMinor: 40_000, description: 'RETURNED PAYMENT' }),
        row({ transactionDate: '2026-03-13', amountMinor: -40_000, description: 'AUTOMATIC PAYMENT - THANK' }),
      ],
      // A bill paid with the card, stored as a payment by an older converter: it adds the payment's amount back too.
      citi2: [
        row({ transactionDate: '2026-02-01', amountMinor: -8_800, description: 'ONLINE PAYMENT, THANK YOU' }),
        row({ transactionDate: '2026-02-06', amountMinor: 8_800, description: 'AUTOPAY PAYMENT SAMPLE UTILITY' }),
      ],
    };
    const imp = () => [
      repo.importCardTransactions({ cardAccountId: chase2.id, source: 'test-sync', parserVersion: 'test@1', rows: [...rows.chase2], coverage }),
      repo.importCardTransactions({ cardAccountId: citi2.id, source: 'test-sync', parserVersion: 'test@1', rows: [...rows.citi2], coverage }),
    ];
    imp();
    const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] });
    const find = (cardAccountId: string, transactionDate: string, amountMinor: number) =>
      all.find((item) => item.cardAccountId === cardAccountId && item.transactionDate === transactionDate && item.amountMinor === amountMinor)!.id;
    const first = find(chase2.id, '2026-03-10', -40_000);
    const reversal = find(chase2.id, '2026-03-13', 40_000);
    const again = find(chase2.id, '2026-03-13', -40_000);
    const citiPayment = find(citi2.id, '2026-02-01', -8_800);
    const charge = find(citi2.id, '2026-02-06', 8_800);
    const ledger = [...debits, debit(20, '2026-03-17', -40_000, CHASE)];
    const app = buildApp(checkingLedger(ledger));

    const body = await reconciliation(app);
    expect(body.rulesVersion).toBe(6);
    expect(body.returned).toEqual([{
      payment: { id: first, cardAccountId: chase2.id, date: '2026-03-10', amountMinor: -40_000, currency: 'USD', description: 'AUTOMATIC PAYMENT - THANK' },
      reversal: { id: reversal, cardAccountId: chase2.id, date: '2026-03-13', amountMinor: 40_000, currency: 'USD', description: 'RETURNED PAYMENT' },
      dayOffset: 3,
    }]);
    expect(pairIds(body)).toContainEqual([again, chk(20), 'matched']);
    const unmatched = body.unmatchedPayments as Array<{ payment: { id: string }; possibleReversals?: unknown }>;
    expect(unmatched.map((item) => item.payment.id)).not.toContain(first);
    expect(unmatched.filter((item) => item.possibleReversals !== undefined)).toEqual([expect.objectContaining({
      payment: expect.objectContaining({ id: citiPayment }),
      possibleReversals: [{ reversal: expect.objectContaining({ id: charge, amountMinor: 8_800, description: 'AUTOPAY PAYMENT SAMPLE UTILITY' }), dayOffset: 5 }],
    })]);
    const [usd] = body.totals as Array<{ payments: Record<string, { count: number; amountMinor: number }> }>;
    expect(usd.payments.returned).toEqual({ count: 1, amountMinor: -40_000 });
    for (const field of ['count', 'amountMinor'] as const) {
      expect(usd.payments.all[field]).toBe(['matched', 'confirmed', 'ambiguous', 'unmatched', 'elsewhere', 'returned']
        .reduce((sum, part) => sum + usd.payments[part][field], 0));
    }

    // Its detail says so, with the reversal; the other is unmatched with the charge offered; the reversal is no payment.
    const detail = async (id: string) => (await get(app, `/spending/payment-reconciliation/payments/${id}`)).body.paymentMatch;
    expect(await detail(first)).toEqual({
      status: 'returned',
      reversal: { id: reversal, cardAccountId: chase2.id, date: '2026-03-13', amountMinor: 40_000, currency: 'USD', description: 'RETURNED PAYMENT', dayOffset: 3 },
    });
    expect(await detail(citiPayment)).toEqual({
      status: 'unmatched', reason: 'no-checking-debit', possibleDebits: [],
      possibleReversals: [expect.objectContaining({ id: charge, dayOffset: 5 })],
    });
    expect(await detail(reversal)).toBeNull();

    // The same files imported again change nothing.
    for (const batch of imp()) expect(batch.newCount).toBe(0);
    expect(await reconciliation(app)).toEqual(body);

    // The owner's answer stands over the rule: said paid from another account, it is no longer returned.
    expect((await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: first })).status).toBe(201);
    const answered = await reconciliation(app);
    expect(answered.returned).toEqual([]);
    expect(answered.elsewhere.map((item: { payment: { id: string } }) => item.payment.id)).toContain(first);
  });

  /** A Chase payment the card took back, then paid again; and a Citi payment beside a payment-worded charge of its amount. */
  function importReturns() {
    const coverage = { start: '2023-01-01', end: '2026-10-15' };
    const chase2 = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '0066', currency: 'USD' });
    const citi2 = repo.createCardAccount({ issuer: 'citi', owner: 'casey', last4: '0077', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: chase2.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row({ transactionDate: '2026-03-10', amountMinor: -40_000, description: 'AUTOMATIC PAYMENT - THANK' }),
      row({ transactionDate: '2026-03-13', amountMinor: 40_000, description: 'RETURNED PAYMENT' }),
      row({ transactionDate: '2026-03-13', amountMinor: -40_000, description: 'AUTOMATIC PAYMENT - THANK' }),
    ] });
    repo.importCardTransactions({ cardAccountId: citi2.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row({ transactionDate: '2026-02-01', amountMinor: -8_800, description: 'ONLINE PAYMENT, THANK YOU' }),
      row({ transactionDate: '2026-02-06', amountMinor: 8_800, description: 'AUTOPAY PAYMENT SAMPLE UTILITY' }),
    ] });
    const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] });
    const find = (cardAccountId: string, transactionDate: string, amountMinor: number) =>
      all.find((item) => item.cardAccountId === cardAccountId && item.transactionDate === transactionDate && item.amountMinor === amountMinor)!.id;
    return {
      first: find(chase2.id, '2026-03-10', -40_000), reversal: find(chase2.id, '2026-03-13', 40_000), again: find(chase2.id, '2026-03-13', -40_000),
      citiPayment: find(citi2.id, '2026-02-01', -8_800), charge: find(citi2.id, '2026-02-06', 8_800),
    };
  }

  it('only offers the reversal where the payment made again was matched to a debit that came back (Root 15:42Z)', async () => {
    const { debits } = seed();
    const ids = importReturns();
    const paid = debit(20, '2026-03-17', -40_000, CHASE);
    // The debit stands: the payment made again does not compete, and the first is returned.
    expect((await reconciliation(buildApp(checkingLedger([...debits, paid])))).returned.map((item: { payment: { id: string } }) => item.payment.id))
      .toEqual([ids.first]);
    // A credit of its amount four days later that is no returned item (money sent back): the payment made again
    // competes, so nothing is settled, and stays matched.
    const transfer: ReconciliationCheckingRow = { ...debit(21, '2026-03-21', 40_000, 'ONLINE TRANSFER FROM SAMPLE SAVINGS') };
    const stood = await reconciliation(buildApp(checkingLedger([...debits, paid, transfer])));
    expect(stood.returned).toEqual([]);
    expect(pairIds(stood)).toContainEqual([ids.again, chk(20), 'matched']);
    expect(stood.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === ids.first)).toEqual(expect.objectContaining({
      reason: 'no-checking-debit',
      possibleReversals: [{ reversal: expect.objectContaining({ id: ids.reversal, description: 'RETURNED PAYMENT' }), dayOffset: 3 }],
    }));
    // The bank returned the debit unpaid four days later (Root 02:32Z): the pull nets with its return and pays nothing,
    // so both payments are left with no debit, and the reversal, fitting both, is only offered.
    const credit: ReconciliationCheckingRow = { ...debit(21, '2026-03-21', 40_000, 'SAMPLE ITEM RETURNED 999999') };
    const app = buildApp(checkingLedger([...debits, paid, credit]));
    const body = await reconciliation(app);
    expect(body.returned).toEqual([]);
    expect(pairIds(body).filter(([, debitId]: string[]) => debitId === chk(20))).toEqual([]);
    expect(body.returnedDebits).toEqual([{ debit: expect.objectContaining({ id: chk(20), class: 'card-payment' }), returnedOn: '2026-03-21', dayOffset: 4 }]);
    expect(body.unmatchedPayments.filter((item: { payment: { id: string } }) => [ids.first, ids.again].includes(item.payment.id))
      .map((item: { payment: { id: string }; possibleReversals: Array<{ reversal: { id: string }; dayOffset: number }> }) =>
        [item.payment.id, item.possibleReversals.map((option) => [option.reversal.id, option.dayOffset])]))
      .toEqual([[ids.first, [[ids.reversal, 3]]], [ids.again, [[ids.reversal, 0]]]]);
    expect((await get(app, `/spending/payment-reconciliation/payments/${ids.first}`)).body.paymentMatch).toEqual(expect.objectContaining({
      status: 'unmatched', possibleReversals: [expect.objectContaining({ id: ids.reversal, dayOffset: 3 })],
    }));
    // A credit is never shown as a debit on either side.
    expect(JSON.stringify(body)).not.toContain(chk(21));
  });

  it('shows a returned payment, and a reversal offered with a gap, with no checking tables at all (Root 15:42Z)', async () => {
    const { ids: seeded } = seed();
    const coverage = { start: '2023-01-01', end: '2026-10-15' };
    const chase3 = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '0088', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: chase3.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row({ transactionDate: '2026-03-02', amountMinor: -6_100, description: 'AUTOMATIC PAYMENT - THANK' }),
      row({ transactionDate: '2026-03-05', amountMinor: 6_100, description: 'RETURNED PAYMENT' }),
    ] });
    const ids = importReturns();
    const all = repo.listCardTransactionsMatching({ statuses: ['posted'] });
    const returnedPayment = all.find((item) => item.cardAccountId === chase3.id && item.amountMinor === -6_100)!.id;
    const returnedBy = all.find((item) => item.cardAccountId === chase3.id && item.amountMinor === 6_100)!.id;
    for (const ledger of [null, checkingLedger([], { installed: false })]) {
      const app = buildApp(ledger);
      const body = await reconciliation(app);
      expect(body.checking.installed).toBe(false);
      expect(body.returned).toEqual([{ payment: expect.objectContaining({ id: returnedPayment }), reversal: expect.objectContaining({ id: returnedBy }), dayOffset: 3 }]);
      const offered = (id: string) => body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === id)?.possibleReversals;
      expect(offered(ids.citiPayment)).toEqual([{ reversal: expect.objectContaining({ id: ids.charge }), dayOffset: 5 }]);
      // Without checking, nothing tells the payment made again apart: both Chase payments are offered the reversal.
      expect([offered(ids.first), offered(ids.again)]).toEqual([
        [{ reversal: expect.objectContaining({ id: ids.reversal }), dayOffset: 3 }], [{ reversal: expect.objectContaining({ id: ids.reversal }), dayOffset: 0 }],
      ]);
      const detail = async (id: string) => (await get(app, `/spending/payment-reconciliation/payments/${id}`)).body;
      expect(await detail(returnedPayment)).toEqual({
        checking: { installed: false }, decisions: { installed: false },
        paymentMatch: { status: 'returned', reversal: expect.objectContaining({ id: returnedBy, dayOffset: 3, description: 'RETURNED PAYMENT' }) },
      });
      expect((await detail(ids.citiPayment)).paymentMatch).toEqual({
        status: 'unmatched', reason: 'no-checking-account', possibleDebits: [],
        possibleReversals: [expect.objectContaining({ id: ids.charge, dayOffset: 5 })],
      });
      // A payment the card's rows say nothing of has no checking side to show, as before.
      expect((await detail(seeded.amexSep)).paymentMatch).toBeNull();
    }
  });
});

describe('owner decisions', () => {
  it('are a 409 until the operator installs their table; reads work without it', async () => {
    const { ids } = seed();
    const app = buildApp(checkingLedger([]));
    const res = await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: CARD_PAYMENT_DECISIONS_NOT_INSTALLED });
    expect((await send(app, 'delete', `${DECISIONS}/cpd_${'a'.repeat(32)}`)).status).toBe(409);
  });

  it('confirm one pairing of an ambiguous group, reject, undo, and mark gaps paid elsewhere or not a card payment', async () => {
    const { ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));

    const confirmed = await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(8) });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.decision).toEqual({
      id: expect.stringMatching(/^cpd_[a-p]{32}$/), decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(8),
      amountMinor: -30_000, currency: 'USD', createdAt: '2026-10-16T12:00:00.000Z', rulesVersion: 6, dayOffset: 2, revokedAt: null,
    });
    // The rest of the group is matched again by the rules: the citi payment and the other debit are each other's only one.
    let body = await reconciliation(app);
    expect(body.decisions.installed).toBe(true);
    expect(body.ambiguous).toEqual([]);
    expect(pairIds(body)).toEqual(expect.arrayContaining([[ids.amexJul, chk(8), 'confirmed'], [ids.amex2Jul, chk(7), 'matched']]));
    expect(body.pairs.find((pair: { status: string }) => pair.status === 'confirmed').decisionId).toBe(confirmed.body.decision.id);

    // A payment or debit already decided is a 409 until the decision is undone.
    const again = await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(7) });
    expect([again.status, again.body.error]).toEqual([409, 'this card payment already has a decision in force; undo it first']);
    const undo = await send(app, 'delete', `${DECISIONS}/${confirmed.body.decision.id}`);
    expect(undo.status).toBe(200);
    expect(undo.body.decision.revokedAt).toBe('2026-10-16T12:00:00.000Z');
    body = await reconciliation(app);
    expect(body.ambiguous).toHaveLength(1);

    // Rejecting one candidate pair leaves the group to be matched again by the rules.
    const rejected = await send(app, 'post', DECISIONS, { decision: 'rejected', cardTransactionId: ids.amexJul, checkingTransactionId: chk(7) });
    expect(rejected.status).toBe(201);
    body = await reconciliation(app);
    expect(body.ambiguous).toHaveLength(1);
    expect(body.ambiguous[0].candidates).toHaveLength(3);
    // The rejection is listed with its rows, so it can be undone.
    expect(body.decisions.answers).toEqual([{
      id: rejected.body.decision.id, decision: 'rejected', createdAt: '2026-10-16T12:00:00.000Z',
      payment: expect.objectContaining({ id: ids.amexJul }), debit: expect.objectContaining({ id: chk(7) }),
    }]);

    const elsewhere = await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun });
    const notCard = await send(app, 'post', DECISIONS, { decision: 'not-card-payment', checkingTransactionId: chk(10) });
    expect([elsewhere.status, notCard.status]).toEqual([201, 201]);
    body = await reconciliation(app);
    expect(body.elsewhere.map((item: { payment: { id: string } }) => item.payment.id)).toEqual([ids.citiJun]);
    expect(body.notCardPayments.map((item: { debit: { id: string } }) => item.debit.id)).toEqual([chk(10)]);
    expect(body.unmatchedPayments.map((item: { payment: { id: string } }) => item.payment.id)).toEqual([ids.amexOld]);
    expect(body.unmatchedDebits.map((item: { debit: { id: string } }) => item.debit.id)).toEqual([chk(9)]);
    expect(body.totals[0].payments.elsewhere).toEqual({ count: 1, amountMinor: -9_999 });
    expect(body.totals[0].debits.notCardPayment).toEqual({ count: 1, amountMinor: -6_500 });

    expect((await send(app, 'delete', `${DECISIONS}/cpd_${'p'.repeat(32)}`)).status).toBe(404);
    expect((await send(app, 'delete', `${DECISIONS}/not-a-decision`)).status).toBe(404);
  });

  it('lists an answer whose debit is gone as no longer fitting, and frees its payment once it is undone', async () => {
    const { ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const confirmed = await send(buildApp(checkingLedger(debits)), 'post', DECISIONS,
      { decision: 'confirmed', cardTransactionId: ids.citiJun, checkingTransactionId: chk(11) });
    expect(confirmed.status).toBe(201);
    const app = buildApp(checkingLedger(debits.filter((item) => item.id !== chk(11))));
    const body = await reconciliation(app);
    expect(body.decisions.stale).toEqual([{ decisionId: confirmed.body.decision.id, reason: 'row-missing' }]);
    expect(body.decisions.answers).toEqual([{
      id: confirmed.body.decision.id, decision: 'confirmed', createdAt: '2026-10-16T12:00:00.000Z', stale: 'row-missing',
      payment: expect.objectContaining({ id: ids.citiJun }),
    }]);
    // The answer still holds the payment until it is undone.
    const blocked = await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun });
    expect([blocked.status, blocked.body.error]).toEqual([409, 'this card payment already has a decision in force; undo it first']);
    expect((await send(app, 'delete', `${DECISIONS}/${confirmed.body.decision.id}`)).status).toBe(200);
    expect((await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun })).status).toBe(201);
    expect((await reconciliation(app)).decisions).toEqual({ installed: true, stale: [], answers: [] });
  });

  it('checks every decision against the rows, and answers without repeating what was sent', async () => {
    const { ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger([...debits, debit(30, '2026-09-30', -50_000, SAVINGS), debit(32, '2026-09-25', -50_000, BILT_RENT)]));
    const cases: Array<[unknown, number, string]> = [
      [{ decision: 'maybe', cardTransactionId: ids.amexSep }, 400, 'decision must be one of confirmed, rejected, elsewhere, not-card-payment'],
      [{ decision: 'confirmed', cardTransactionId: ids.amexSep }, 400, 'confirmed and rejected name a card payment and a checking debit; elsewhere a card payment; not-card-payment a checking debit'],
      [{ decision: 'elsewhere', cardTransactionId: ids.amexSep, extra: 1 }, 400, 'body has an unexpected key'],
      [{ decision: 'elsewhere', cardTransactionId: 'card-txn-nope' }, 400, 'cardTransactionId must be a card transaction id'],
      [{ decision: 'not-card-payment', checkingTransactionId: 'chk-txn-nope' }, 400, 'checkingTransactionId must be a checking transaction id'],
      [{ decision: 'elsewhere', cardTransactionId: `card-txn-${'p'.repeat(32)}` }, 404, 'card transaction not found'],
      [{ decision: 'not-card-payment', checkingTransactionId: chk(999) }, 404, 'checking transaction not found'],
      [{ decision: 'elsewhere', cardTransactionId: ids.amexPurchase }, 400, 'cardTransactionId must name a posted payment to a card'],
      [{ decision: 'elsewhere', cardTransactionId: ids.amexPending }, 400, 'cardTransactionId must name a posted payment to a card'],
      [{ decision: 'confirmed', cardTransactionId: ids.amexSep, checkingTransactionId: chk(3) }, 400, 'the payment and the debit must have one amount and currency'],
      [{ decision: 'rejected', cardTransactionId: ids.amexSep, checkingTransactionId: chk(3) }, 400, 'the payment and the debit must have one amount and currency'],
      [{ decision: 'confirmed', cardTransactionId: ids.amexSep, checkingTransactionId: chk(32) }, 400, 'a Bilt housing pull pays only a Bilt housing payment, and a Bilt housing payment is paid only by a Bilt housing pull'],
      [{ decision: 'confirmed', cardTransactionId: ids.amexOld, checkingTransactionId: chk(10) }, 400, 'the payment and the debit must have one amount and currency'],
      [[1, 2], 400, 'body must be an object'],
      ['{"decision":', 400, 'the request body is not valid JSON'],
    ];
    for (const [body, status, error] of cases) {
      const res = await send(app, 'post', DECISIONS, body);
      expect([res.status, res.body.error], JSON.stringify(body)).toEqual([status, error]);
    }
    // A pair further apart than the confirm window is refused, confirmed or rejected; any other debit of the payment's
    // amount may be confirmed.
    const far = debit(31, '2026-09-20', -42_110, SAVINGS);
    const farApp = buildApp(checkingLedger([...debits, far]));
    for (const decision of ['confirmed', 'rejected']) {
      const tooFar = await send(farApp, 'post', DECISIONS, { decision, cardTransactionId: ids.amexAug, checkingTransactionId: chk(31) });
      expect([tooFar.status, tooFar.body.error]).toEqual([400, 'the payment and the debit must be at most 15 days apart']);
    }
    const savings = await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.amexSep, checkingTransactionId: chk(30) });
    expect(savings.status).toBe(201);
    // Card data anywhere in the body is a 422 with paths only; the service token never decides.
    const card = await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: '4111 1111 1111 1111' });
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
    expect((await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun }, 'service')).status).toBe(403);
    expect((await send(app, 'delete', `${DECISIONS}/cpd_${'a'.repeat(32)}`, undefined, 'service')).status).toBe(403);
    // Without a checking ledger, nothing that names a debit can be decided.
    const without = await send(buildApp(null), 'post', DECISIONS, { decision: 'not-card-payment', checkingTransactionId: chk(10) });
    expect([without.status, without.body.error]).toEqual([409, 'checking accounts are not installed on this Holdr']);
  });

  it('lets the owner confirm up to 15 days apart, with the day gap kept, while the rules match and offer within 5 only', async () => {
    const { ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    // The Citi payment Holdr has no Citi debit for (Jun 15), and Citi debits of its amount 6, 15 and 16 days either side.
    const app = buildApp(checkingLedger([...debits,
      debit(70, '2026-06-21', -9_999, CITI), debit(71, '2026-06-30', -9_999, CITI), debit(72, '2026-07-01', -9_999, CITI),
      debit(73, '2026-05-31', -9_999, CITI), debit(74, '2026-05-30', -9_999, CITI)]));
    const stored = () => repo.internalGetDb().prepare('SELECT count(*) AS n FROM card_payment_decisions').get();
    const body = await reconciliation(app);
    expect(body.pairs.map((pair: { payment: { id: string } }) => pair.payment.id)).not.toContain(ids.citiJun);
    // Six days out: never matched, never offered; the offer is the savings transfer a day after.
    expect(body.unmatchedPayments.find((item: { payment: { id: string } }) => item.payment.id === ids.citiJun).possibleDebits
      .map((item: { debit: { id: string } }) => item.debit.id)).toEqual([chk(11)]);
    for (const [n, dayOffset] of [[70, 6], [71, 15], [73, -15]] as const) {
      const confirmed = await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.citiJun, checkingTransactionId: chk(n) });
      expect([confirmed.status, confirmed.body.decision.dayOffset]).toEqual([201, dayOffset]);
      expect(pairIds(await reconciliation(app))).toContainEqual([ids.citiJun, chk(n), 'confirmed']);
      expect((await send(app, 'delete', `${DECISIONS}/${confirmed.body.decision.id}`)).status).toBe(200);
    }
    const before = stored();
    for (const [n, decision] of [[72, 'confirmed'], [72, 'rejected'], [74, 'confirmed']] as const) {
      const refused = await send(app, 'post', DECISIONS, { decision, cardTransactionId: ids.citiJun, checkingTransactionId: chk(n) });
      expect([refused.status, refused.body.error]).toEqual([400, 'the payment and the debit must be at most 15 days apart']);
    }
    expect(stored()).toEqual(before);
  });

  it('answers a decisions table in another shape with the fixed conflict, matching nothing and ignoring no stored answer', async () => {
    const { ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    // The sole candidate of the Sep Amex payment, rejected; then something else is put on the table.
    expect((await send(app, 'post', DECISIONS, { decision: 'rejected', cardTransactionId: ids.amexSep, checkingTransactionId: chk(1) })).status).toBe(201);
    repo.internalGetDb().exec('CREATE INDEX synthetic_extra_index ON card_payment_decisions (currency)');
    const conflict = [409, { error: CARD_PAYMENT_DECISIONS_CONFLICT, code: 'card-payment-decisions-conflict' }];
    for (const res of [
      await get(app, '/spending/payment-reconciliation'),
      await get(app, `/spending/payment-reconciliation/payments/${ids.amexSep}`),
      await get(app, '/spending/payment-reconciliation', 'service'),
      await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun }),
      await send(app, 'delete', `${DECISIONS}/cpd_${'a'.repeat(32)}`),
    ]) {
      expect([res.status, res.body]).toEqual(conflict);
    }
    // The stored rejection stays as it was; nothing else was written.
    expect(repo.internalGetDb().prepare('SELECT decision, revoked_at FROM card_payment_decisions').all()).toEqual([{ decision: 'rejected', revoked_at: null }]);
    // Put back in shape, the rejection holds again: the pair is not matched.
    repo.internalGetDb().exec('DROP INDEX synthetic_extra_index');
    expect(pairIds(await reconciliation(app))).not.toContainEqual([ids.amexSep, chk(1), 'matched']);
  });

  it('sends a debit naming more than one issuer to the owner with each named issuer\'s payment', async () => {
    const { ids, debits } = seed();
    // The Sep Amex and Citi payments (same amount), and one debit naming both instead of their own.
    const app = buildApp(checkingLedger([...debits.filter((item) => item.id !== chk(1) && item.id !== chk(2)),
      debit(80, '2026-09-26', -50_000, 'BILL PAY CITI CREDIT CARD AMEX PAYMENT 999999')]));
    const body = await reconciliation(app);
    const group = body.ambiguous.find((item: { debits: Array<{ id: string }> }) => item.debits.some((entry) => entry.id === chk(80)));
    expect(group.payments.map((item: { id: string }) => item.id)).toEqual([ids.amexSep, ids.citiSep]);
    expect(group.debits).toEqual([expect.objectContaining({ id: chk(80), payee: 'several', payeeLabel: 'More than one issuer' })]);
    expect(body.pairs.map((pair: { debit: { id: string } }) => pair.debit.id)).not.toContain(chk(80));
  });
});

describe('stability and spending', () => {
  it('answers the same after the same files are imported again, decisions included', async () => {
    const { ids, debits, cards } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    expect((await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(7) })).status).toBe(201);
    const before = await reconciliation(app);
    const coverage = { start: '2023-01-01', end: '2026-10-15' };
    for (const [card, rows] of [[cards.amex, CARD_ROWS.amex], [cards.amex2, CARD_ROWS.amex2], [cards.citi, CARD_ROWS.citi], [cards.chase, CARD_ROWS.chase], [cards.bilt, CARD_ROWS.bilt]] as const) {
      const batch = repo.importCardTransactions({ cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', rows: [...rows], coverage });
      expect(batch.newCount).toBe(0);
    }
    // The checking ledger read in another order, as a later import of the same days returns it, changes nothing either.
    const again = await reconciliation(buildApp(checkingLedger([...debits].reverse())));
    expect(again).toEqual(before);
    expect(await reconciliation(app)).toEqual(before);
  });

  it('never changes what spending, the accounting or the insights count', async () => {
    const { ids, debits } = seed();
    const plain = buildApp(null);
    const urls = ['/spending/summary', '/spending/summary?from=2026-07-01&to=2026-09-30', '/spending/insights?month=2026-09&today=2026-10-16',
      '/card-transactions?limit=200', '/card-transactions?kind=payment'];
    const before = await Promise.all(urls.map(async (url) => (await get(plain, url)).body));
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(7) });
    await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun });
    await reconciliation(app);
    const after = await Promise.all(urls.map(async (url) => (await get(app, url)).body));
    expect(after).toEqual(before);
    // Payments stay transfers: their total is the summary's own, and never in spending.
    const summary = before[0] as { totals: Array<{ paymentsMinor: number; spendingMinor: number }> };
    expect(summary.totals[0].paymentsMinor).toBe(-544_720);
  });
});

describe('GET /spending/payment-reconciliation/payments/:id', () => {
  const match = async (app: express.Express, id: string, auth = 'ok') => {
    const res = await get(app, `/spending/payment-reconciliation/payments/${id}`, auth);
    expect(res.status).toBe(200);
    return res.body;
  };

  it('says where one payment stands against the checking debits, masked as the reconciliation shows them', async () => {
    const { ids, debits } = seed();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    const matched = await match(app, ids.amexSep);
    expect(matched).toEqual({
      checking: { installed: true }, decisions: { installed: true },
      paymentMatch: { status: 'matched', debit: expect.objectContaining({ id: chk(1), payeeLabel: 'American Express', dayOffset: 1, descriptor: 'AMEX EPAYMENT ACH PMT ***9999 W9999 SAMPLE HOLDER' }) },
    });
    expect((await match(app, ids.amexJul)).paymentMatch).toEqual({
      status: 'ambiguous', otherPayments: 1,
      candidates: [expect.objectContaining({ id: chk(7), dayOffset: 1 }), expect.objectContaining({ id: chk(8), dayOffset: 2 })],
    });
    expect((await match(app, ids.citiJun)).paymentMatch).toEqual({
      status: 'unmatched', reason: 'no-checking-debit', possibleDebits: [expect.objectContaining({ id: chk(11), class: 'other' })],
    });
    expect((await match(app, ids.amexPending)).paymentMatch).toEqual({ status: 'pending' });
    expect((await match(app, ids.amexPurchase)).paymentMatch).toBeNull();
    await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun });
    expect((await match(app, ids.citiJun)).paymentMatch).toEqual({ status: 'elsewhere', decisionId: expect.stringMatching(/^cpd_/) });
    // Readable with the service token, as every card spending read; never without a sign-in.
    expect((await match(app, ids.amexSep, 'service')).paymentMatch.status).toBe('matched');
    expect((await get(app, `/spending/payment-reconciliation/payments/${ids.amexSep}`, 'nobody')).status).toBe(401);
    // Without a checking ledger there is no checking side; the owner's word that a payment was paid elsewhere stands.
    expect(await match(buildApp(null), ids.amexSep)).toEqual({ checking: { installed: false }, decisions: { installed: true }, paymentMatch: null });
    expect((await match(buildApp(null), ids.citiJun)).paymentMatch).toEqual({ status: 'elsewhere', decisionId: expect.stringMatching(/^cpd_/) });
    expect((await match(buildApp(null), ids.amexPending)).paymentMatch).toBeNull();
  });

  it('answers 404 for an id that names no card row, 422 for card data in it, and refuses query parameters', async () => {
    const { ids } = seed();
    const app = buildApp(checkingLedger([]));
    for (const id of [`card-txn-${'p'.repeat(32)}`, 'not-an-id', `chk-txn-${'a'.repeat(32)}`]) {
      const res = await get(app, `/spending/payment-reconciliation/payments/${id}`);
      expect([res.status, res.body.error]).toEqual([404, 'card transaction not found']);
    }
    const card = await get(app, '/spending/payment-reconciliation/payments/4111111111111111');
    expect([card.status, card.body.paths]).toEqual([422, ['params.id']]);
    expect(JSON.stringify(card.body)).not.toContain('4111');
    expect((await get(app, `/spending/payment-reconciliation/payments/${ids.amexSep}?full=1`)).status).toBe(400);
  });

  it('leaves GET /card-transactions/:id byte-identical, with and without a checking ledger and decisions', async () => {
    const { ids, debits } = seed();
    const urls = Object.values(ids).map((id) => `/card-transactions/${id}`);
    const read = async (app: express.Express) => Promise.all(urls.map(async (url) => {
      const res = await get(app, url);
      return [res.status, res.text];
    }));
    const before = await read(buildApp(null));
    expect(await read(buildApp(checkingLedger(debits)))).toEqual(before);
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    await send(app, 'post', DECISIONS, { decision: 'confirmed', cardTransactionId: ids.amexJul, checkingTransactionId: chk(7) });
    await send(app, 'post', DECISIONS, { decision: 'elsewhere', cardTransactionId: ids.citiJun });
    expect(await read(app)).toEqual(before);
    expect(await read(buildApp(null))).toEqual(before);
    for (const [, text] of before) expect(text).not.toContain('paymentMatch');
  });
});

describe('pairs matched from evidence, through the route', () => {
  const autopay = (last4: string, holder: string) => `CHASE CREDIT CRD AUTOPAY 999999 ***${last4} ${holder}`;
  const REF_A = autopay('0001', 'SAMPLE HOLDER');
  const REF_B = autopay('0002', 'OTHER HOLDER');

  /**
   * Two Chase cards, each paid twice before by its own autopay; then one amount paid to both three days apart, which
   * the rules alone hold for the owner and the payer references settle. Two Amex payments of one card, day, amount and
   * text, paid by a Fifth Third debit and a Wells Fargo retry: interchangeable rows.
   */
  function seedEvidence() {
    const coverage = { start: '2026-01-01', end: '2026-10-15' };
    const chaseA = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '0061', currency: 'USD' });
    const chaseB = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '0062', currency: 'USD' });
    const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0063', currency: 'USD' });
    const imp = (id: string, rows: CardImportRow[]) => repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage });
    imp(chaseA.id, [row({ transactionDate: '2026-03-05', amountMinor: -11_100 }), row({ transactionDate: '2026-04-05', amountMinor: -12_200 }),
      row({ transactionDate: '2026-09-10', amountMinor: -77_700 })]);
    imp(chaseB.id, [row({ transactionDate: '2026-03-08', amountMinor: -13_300 }), row({ transactionDate: '2026-04-08', amountMinor: -14_400 }),
      row({ transactionDate: '2026-09-13', amountMinor: -77_700 })]);
    imp(amex.id, [row({ transactionDate: '2026-08-21', amountMinor: -100_000, description: 'ONLINE PAYMENT - THANK YOU' }),
      row({ transactionDate: '2026-08-21', amountMinor: -100_000, description: 'ONLINE PAYMENT - THANK YOU' })]);
    const all = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['payment'] });
    const find = (cardAccountId: string, transactionDate: string) => all.filter((item) => item.cardAccountId === cardAccountId && item.transactionDate === transactionDate)
      .map((item) => item.id).sort();
    return {
      ids: {
        history: find(chaseA.id, '2026-03-05')[0], a: find(chaseA.id, '2026-09-10')[0], b: find(chaseB.id, '2026-09-13')[0],
        amex: find(amex.id, '2026-08-21'),
      },
      debits: [
        debit(201, '2026-03-05', -11_100, REF_A), debit(202, '2026-04-06', -12_200, REF_A),
        debit(203, '2026-03-09', -13_300, REF_B), debit(204, '2026-04-08', -14_400, REF_B),
        debit(205, '2026-09-11', -77_700, REF_A), debit(206, '2026-09-14', -77_700, REF_B),
        debit(207, '2026-08-24', -100_000, 'WEB INITIATED PAYMENT AT AMEX EPAYMENT', FIFTH),
        debit(208, '2026-08-25', -100_000, 'AMEX EPAYMENT RETRY PYMT 999999 W9999 SAMPLE HOLDER'),
      ],
    };
  }
  const evidenceOf = (body: { pairs: Array<{ payment: { id: string }; debit: { id: string }; evidence?: unknown }> }) =>
    body.pairs.filter((pair) => 'evidence' in pair).map((pair) => [pair.payment.id, pair.debit.id, pair.evidence]);

  it('serves why the rules matched a pair inside a held group, additively: every other pair and field as before', async () => {
    const { ids, debits } = seedEvidence();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    const body = await reconciliation(app);
    expect(body.rulesVersion).toBe(6);
    expect(evidenceOf(body)).toEqual([
      [ids.amex[0], chk(207), { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      [ids.amex[1], chk(208), { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      [ids.a, chk(205), { basis: 'reference', proofs: 2 }],
      [ids.b, chk(206), { basis: 'reference', proofs: 2 }],
    ]);
    expect([body.ambiguous, body.unmatchedPayments, body.unmatchedDebits]).toEqual([[], [], []]);
    expect(body.totals[0].payments.matched.count).toBe(8);
    // A pair the rules matched alone keeps exactly the shape it had: no evidence key at all.
    const history = body.pairs.find((pair: { payment: { id: string } }) => pair.payment.id === ids.history);
    expect(Object.keys(history).sort()).toEqual(['dayOffset', 'debit', 'payment', 'status']);
    expect(history).toEqual({ status: 'matched', dayOffset: 0, payment: expect.objectContaining({ id: ids.history }), debit: expect.objectContaining({ id: chk(201) }) });
    // And so does a payment's detail: the evidence only where the rules matched it from evidence.
    const detail = async (id: string) => (await get(app, `/spending/payment-reconciliation/payments/${id}`)).body.paymentMatch;
    expect(await detail(ids.a)).toEqual({
      status: 'matched', evidence: { basis: 'reference', proofs: 2 },
      debit: expect.objectContaining({ id: chk(205), payeeLabel: 'Chase', dayOffset: 1 }),
    });
    expect(await detail(ids.amex[1])).toEqual({
      status: 'matched', evidence: { basis: 'interchangeable', payments: 2, pairedBy: 'order' },
      debit: expect.objectContaining({ id: chk(208), payeeLabel: 'American Express', dayOffset: 4 }),
    });
    expect(Object.keys(await detail(ids.history)).sort()).toEqual(['debit', 'status']);
    // Every number shown is cut to its last four, the references included.
    for (const text of shownTexts(body)) expect(longDigitRuns(text)).toEqual([]);
  });

  it('undoes a pair matched from evidence through the owner\'s rejection: the group is the owner\'s again, until that is undone', async () => {
    const { ids, debits } = seedEvidence();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    const app = buildApp(checkingLedger(debits));
    // Undo is the existing "not this one" for the pair: a rejection, recorded as any other.
    const undo = await send(app, 'post', DECISIONS, { decision: 'rejected', cardTransactionId: ids.a, checkingTransactionId: chk(205) });
    expect(undo.status).toBe(201);
    expect(undo.body.decision).toEqual(expect.objectContaining({ decision: 'rejected', cardTransactionId: ids.a, checkingTransactionId: chk(205), dayOffset: 1 }));
    let body = await reconciliation(app);
    expect(evidenceOf(body).map(([paymentId]) => paymentId)).toEqual(ids.amex);
    expect(body.ambiguous).toEqual([expect.objectContaining({
      payments: [expect.objectContaining({ id: ids.a }), expect.objectContaining({ id: ids.b })],
      debits: [expect.objectContaining({ id: chk(205) }), expect.objectContaining({ id: chk(206) })],
      candidates: [
        { paymentId: ids.a, debitId: chk(206), dayOffset: 4 },
        { paymentId: ids.b, debitId: chk(206), dayOffset: 1 },
        { paymentId: ids.b, debitId: chk(205), dayOffset: -2 },
      ],
    })]);
    expect(body.decisions.answers).toEqual([{
      id: undo.body.decision.id, decision: 'rejected', createdAt: '2026-10-16T12:00:00.000Z',
      payment: expect.objectContaining({ id: ids.a }), debit: expect.objectContaining({ id: chk(205) }),
    }]);
    expect((await get(app, `/spending/payment-reconciliation/payments/${ids.a}`)).body.paymentMatch).toEqual(expect.objectContaining({ status: 'ambiguous' }));
    // The same for interchangeable rows: their group is the owner's again.
    const amexUndo = await send(app, 'post', DECISIONS, { decision: 'rejected', cardTransactionId: ids.amex[0], checkingTransactionId: chk(207) });
    expect(amexUndo.status).toBe(201);
    body = await reconciliation(app);
    expect(evidenceOf(body)).toEqual([]);
    expect(body.ambiguous.map((group: { payments: Array<{ id: string }> }) => group.payments.map((item) => item.id))).toEqual([ids.amex, [ids.a, ids.b]]);
    // Undoing the rejections: the evidence matches again.
    expect((await send(app, 'delete', `${DECISIONS}/${undo.body.decision.id}`)).status).toBe(200);
    expect((await send(app, 'delete', `${DECISIONS}/${amexUndo.body.decision.id}`)).status).toBe(200);
    body = await reconciliation(app);
    expect(evidenceOf(body)).toHaveLength(4);
    expect(body.ambiguous).toEqual([]);
  });

  it('never hands an undone pair\'s debit to another payment or card (PR231-R1)', async () => {
    const { ids, debits } = seedEvidence();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    // One debit for each held group: two Amex payments with one Fifth Third debit, two Chase cards with A's autopay.
    const app = buildApp(checkingLedger(debits.filter((row) => row.id !== chk(206) && row.id !== chk(208))));
    let body = await reconciliation(app);
    expect(evidenceOf(body)).toEqual([
      [ids.amex[0], chk(207), { basis: 'interchangeable', payments: 2, pairedBy: 'order' }],
      [ids.a, chk(205), { basis: 'reference', proofs: 2 }],
    ]);
    for (const [cardTransactionId, checkingTransactionId] of [[ids.amex[0], chk(207)], [ids.a, chk(205)]]) {
      expect((await send(app, 'post', DECISIONS, { decision: 'rejected', cardTransactionId, checkingTransactionId })).status).toBe(201);
    }
    body = await reconciliation(app);
    // Neither debit moved to the group's other payment, nor to the other card: each waits for the owner's word.
    expect(body.pairs.filter((pair: { debit: { id: string } }) => [chk(205), chk(207)].includes(pair.debit.id))).toEqual([]);
    expect(body.ambiguous.map((group: { payments: Array<{ id: string }>; debits: Array<{ id: string }> }) =>
      [group.payments.map((item) => item.id), group.debits.map((item) => item.id)])).toEqual([[[ids.amex[1]], [chk(207)]], [[ids.b], [chk(205)]]]);
    expect(body.unmatchedPayments.map((item: { payment: { id: string } }) => item.payment.id)).toEqual([ids.amex[0], ids.a]);
    for (const id of [ids.amex[1], ids.b]) {
      expect((await get(app, `/spending/payment-reconciliation/payments/${id}`)).body.paymentMatch.status).toBe('ambiguous');
    }
  });

  it('keeps a rejected pull with the owner while the owner answers the group\'s other rows (PR231-R1, Root 03:30Z)', async () => {
    const { ids, debits } = seedEvidence();
    installCardPaymentDecisionsSchema(repo.internalGetDb());
    // Both Chase autopays; for the two Amex payments, the Fifth Third debit alone.
    const app = buildApp(checkingLedger(debits.filter((row) => row.id !== chk(208))));
    const decide = async (input: Record<string, unknown>) => expect((await send(app, 'post', DECISIONS, input)).status).toBe(201);
    // "Not this one" to A's autopay for card A, then card A paid by B's autopay; "not this one" to the Fifth Third
    // debit for the first Amex payment, then that payment paid from another account.
    await decide({ decision: 'rejected', cardTransactionId: ids.a, checkingTransactionId: chk(205) });
    await decide({ decision: 'confirmed', cardTransactionId: ids.a, checkingTransactionId: chk(206) });
    await decide({ decision: 'rejected', cardTransactionId: ids.amex[0], checkingTransactionId: chk(207) });
    await decide({ decision: 'elsewhere', cardTransactionId: ids.amex[0] });
    const body = await reconciliation(app);
    // Neither rejected debit went to the group's last payment by itself: each waits with it for the owner's word.
    expect(body.pairs.filter((pair: { debit: { id: string } }) => [chk(205), chk(207)].includes(pair.debit.id))).toEqual([]);
    expect(body.pairs.find((pair: { payment: { id: string } }) => pair.payment.id === ids.a))
      .toEqual(expect.objectContaining({ status: 'confirmed', debit: expect.objectContaining({ id: chk(206) }) }));
    expect(body.ambiguous.map((group: { payments: Array<{ id: string }>; debits: Array<{ id: string }> }) =>
      [group.payments.map((item) => item.id), group.debits.map((item) => item.id)])).toEqual([[[ids.amex[1]], [chk(207)]], [[ids.b], [chk(205)]]]);
    for (const id of [ids.amex[1], ids.b]) {
      expect((await get(app, `/spending/payment-reconciliation/payments/${id}`)).body.paymentMatch.status).toBe('ambiguous');
    }
  });

  it('nets a pull its bank returned unpaid with its return, and never pairs it (Root 02:32Z)', async () => {
    const { ids, debits } = seedEvidence();
    const unpaid = debit(209, '2026-08-26', 100_000, 'UNPAID ITEM RETURN 999999');
    const body = await reconciliation(buildApp(checkingLedger([...debits, unpaid])));
    expect(body.returnedDebits).toEqual([{ debit: expect.objectContaining({ id: chk(208), class: 'card-payment' }), returnedOn: '2026-08-26', dayOffset: 1 }]);
    expect(body.pairs.filter((pair: { debit: { id: string } }) => pair.debit.id === chk(208))).toEqual([]);
    expect(evidenceOf(body).filter(([paymentId]) => ids.amex.includes(paymentId as string))).toEqual([[ids.amex[0], chk(207), { basis: 'interchangeable', payments: 2, pairedBy: 'order' }]]);
    expect(body.unmatchedPayments.map((item: { payment: { id: string } }) => item.payment.id)).toEqual([ids.amex[1]]);
    expect(body.unmatchedDebits).toEqual([]);
    expect(body.totals[0].debits.returned).toEqual({ count: 1, amountMinor: -100_000 });
  });
});

