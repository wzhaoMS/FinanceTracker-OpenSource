import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  admitBalanceChain,
  balanceChainAccountKey,
  formatBalanceChainReport,
  validateCardScheduleObservation,
  type CheckingImportPayload,
  type ValidCardScheduleObservation,
} from '@finance-tracker/shared';
import { readBalanceChainReport, verifyCardAccountChain } from './balanceChain.js';
import { CardLedgerWriter, type TrackedValues } from './cardLedger/writer.js';
import { importCardScheduleObservations, installCashPlanSchema } from './cashPlan.js';
import { importCheckingPayload } from './checking/importer.js';
import { installCheckingSchema } from './checking/schema.js';
import { SqliteStateRepo, type CardImportRow } from './sqliteStateRepo.js';

// The balance-chain verifier's reads on a database made by this build: checking imports, card rows and statement facts
// written by the real importers. Synthetic only: made-up issuers, last fours, dates, refs and cents.

let dir: string;
let file: string;
let repo: SqliteStateRepo;
const NOW = '2026-11-03T17:00:00.000Z';
const EXTRACTOR = 'synthetic-statement-a@1';
const EXTRACTORS = Object.freeze({ [EXTRACTOR]: 'synthetic layout, with a credit-balance fixture' });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-balance-chain-'));
  file = path.join(dir, 'finance.db');
  repo = new SqliteStateRepo({ file, now: () => new Date(NOW) });
});
afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const db = () => repo.internalGetDb();
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function statement(card: { issuer: string; last4?: string; last5?: string }, closing: string, extra: Record<string, unknown> = {}): ValidCardScheduleObservation {
  const result = validateCardScheduleObservation({
    card, currency: 'USD', sourceKind: 'statement-pdf', sourceRef: sha(`${card.issuer}|${closing}|${JSON.stringify(extra)}`),
    observedAt: '2026-11-02T12:00:00Z', extractorVersion: EXTRACTOR, asOf: { source: 'statement', at: closing, precision: 'date' },
    statementClosingDate: closing, ...extra,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function cardRow(transactionDate: string, amountMinor: number, patch: Partial<CardImportRow> = {}): CardImportRow {
  return {
    transactionDate, postedDate: transactionDate, status: 'posted', amountMinor, currency: 'USD',
    kind: amountMinor < 0 ? 'payment' : 'purchase', description: amountMinor < 0 ? 'ONLINE PAYMENT THANK YOU' : 'SAMPLE SHOP',
    merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

function checkingPayload(): CheckingImportPayload {
  const row = (postedDate: string, amountMinor: number) => ({
    postedDate, amountMinor, description: amountMinor < 0 ? 'SYNTHETIC PAYMENT' : 'SYNTHETIC DEPOSIT', checkNumber: null,
    bankType: amountMinor < 0 ? 'DEBIT' : 'CREDIT', externalIdHash: null,
  });
  return {
    format: 'holdr.checking-import', version: 1, parserVersion: 'synthetic@1',
    account: { institution: 'testbank', type: 'checking', last4: '4321', label: 'Synthetic checking', currency: 'USD' },
    segments: [
      { source: 'wf-statement', coverage: { start: '2026-09-01', end: '2026-09-30' },
        anchors: [{ date: '2026-08-31', balanceMinor: 500_000, kind: 'opening' }, { date: '2026-09-30', balanceMinor: 480_000, kind: 'closing' }],
        rows: [row('2026-09-10', -20_000)] },
      { source: 'wf-statement', coverage: { start: '2026-10-01', end: '2026-10-31' },
        anchors: [{ date: '2026-09-30', balanceMinor: 480_000, kind: 'opening' }, { date: '2026-10-31', balanceMinor: 490_000, kind: 'closing' }],
        rows: [row('2026-10-15', 10_000)] },
    ],
  };
}

/** A posting-dated card (OFX), an Amex card (one date per row) and a card whose statement facts can't anchor. */
function seed() {
  installCheckingSchema(db());
  importCheckingPayload(db(), checkingPayload(), { now: NOW, goId: 'a'.repeat(32), purpose: 'copy-rehearsal' });
  const chase = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '1234', currency: 'USD' });
  repo.importCardTransactions({ cardAccountId: chase.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-08-01', end: '2026-11-02' },
    rows: [cardRow('2026-09-05', 1_500), cardRow('2026-09-20', 2_500), cardRow('2026-10-03', -4_000), cardRow('2026-10-08', 700),
      cardRow('2026-11-01', 999, { status: 'pending', postedDate: null })] });
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0202', last5: '30202', currency: 'USD' });
  repo.importCardTransactions({ cardAccountId: amex.id, source: 'amex-csv', parserVersion: 'synthetic@1', coverage: { start: '2026-08-01', end: '2026-10-15' },
    rows: [cardRow('2026-08-20', 1_000, { postedDate: null }), cardRow('2026-09-14', 300, { postedDate: null }),
      cardRow('2026-09-25', -1_000, { postedDate: null }), cardRow('2026-10-14', 200, { postedDate: null })] });
  const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '5555', currency: 'USD' });
  installCashPlanSchema(db());
  importCardScheduleObservations(db(), [
    statement({ issuer: 'chase', last4: '1234' }, '2026-08-31', { statementBalanceMinor: 0, minimum: { minor: 0, basis: 'total-due' } }),
    statement({ issuer: 'chase', last4: '1234' }, '2026-09-30', { statementBalanceMinor: 4_000 }),
    statement({ issuer: 'chase', last4: '1234' }, '2026-10-31', { statementBalanceMinor: 700, minimum: { minor: 35, basis: 'unknown' } }),
    statement({ issuer: 'amex', last5: '30202' }, '2026-08-15', { statementBalanceMinor: 0 }),
    statement({ issuer: 'amex', last5: '30202' }, '2026-09-15', { statementBalanceMinor: 1_000 }),
    statement({ issuer: 'amex', last5: '30202' }, '2026-10-15', { statementBalanceMinor: 500 }),
    statement({ issuer: 'citi', last4: '5555' }, '2026-09-30', { statementBalanceMinor: 100 }),
    { ...statement({ issuer: 'citi', last4: '5555' }, '2026-10-31', { statementBalanceMinor: 100 }), extractorVersion: 'other-statement@1' },
    statement({ issuer: 'citi', last4: '5555' }, '2026-08-31'),
    statement({ issuer: 'nobank', last4: '0000' }, '2026-10-31', { statementBalanceMinor: 1 }),
  ], { importRef: sha('import'), now: NOW });
  return { chase, amex, citi };
}

const report = (options: Parameters<typeof readBalanceChainReport>[1] = {}) => readBalanceChainReport(db(), { anchorExtractors: EXTRACTORS, ...options });

describe('readBalanceChainReport', () => {
  it('reads every account; checking and posting-dated cards reconcile to the cent', () => {
    const { chase } = seed();
    const result = report();
    expect(result.stores).toEqual({ checking: 'present', statementFacts: 'present' });
    expect(result.accounts.map((account) => `${account.kind}:${account.issuer}:${account.last4}:${account.state}`)).toEqual([
      'checking:testbank:4321:balanced', 'card:amex:0202:not-yet-checked', 'card:chase:1234:balanced', 'card:citi:5555:not-yet-checked',
    ]);
    const checking = result.accounts[0];
    expect(checking).toMatchObject({
      dateBasis: 'posting', result: 'pass', reconciledFrom: '2026-08-31', reconciledThrough: '2026-10-31', latestStatementAnchor: '2026-10-31',
      anchors: { total: 3, chained: 3, byKind: { 'statement-opening': 1, 'statement-closing': 2 } }, steps: { total: 2, pass: 2 },
    });
    const card = result.accounts.find((account) => account.id === chase.id)!;
    // The October facts are held for the minimum's basis only, so they still anchor; the pending row after them changes nothing.
    expect(card).toMatchObject({ dateBasis: 'posting', reconciledThrough: '2026-10-31', anchors: { total: 3, chained: 3, untrusted: 0, excluded: 0 } });
    expect(formatBalanceChainReport(result)).not.toBeNull();
  });

  it('a card whose dates may be transaction dates never passes', () => {
    const { amex } = seed();
    const card = report({ accountId: amex.id, detail: true }).accounts[0];
    expect(card.dateBasis).toBe('timing');
    expect(card.result).toBe('unknown');
    expect(card.reconciledThrough).toBeNull();
    expect(card.detail!.steps.every((step) => step.verdict !== 'pass')).toBe(true);
  });

  it('counts statement facts that cannot anchor: another extractor version, no balance; other source kinds and unbound rows are not anchors', () => {
    const { citi } = seed();
    const card = report({ accountId: citi.id }).accounts[0];
    expect(card.anchors).toMatchObject({ total: 1, untrusted: 1, excluded: 1 });
    expect(card.steps.total).toBe(0);
    // Without the allowlist entry nothing anchors at all.
    expect(readBalanceChainReport(db(), { accountId: citi.id }).accounts[0].anchors).toMatchObject({ total: 0, untrusted: 2, excluded: 1 });
  });

  it('answers one account with every anchor and step, or none for an unknown id', () => {
    const { chase } = seed();
    const one = report({ accountId: chase.id, detail: true });
    expect(one.accounts).toHaveLength(1);
    expect(one.accounts[0].detail!.anchors.map((anchor) => `${anchor.date} ${anchor.state} ${anchor.source}`)).toEqual([
      '2026-08-31 chained statement-facts', '2026-09-30 chained statement-facts', '2026-10-31 chained statement-facts',
    ]);
    expect(one.accounts[0].detail!.anchors.every((anchor) => /^lh1:[a-p]{64}$/.test(anchor.ref))).toBe(true);
    expect(report({ accountId: `card-acct-${'p'.repeat(32)}` }).accounts).toEqual([]);
  });

  it('is value-free: no amount, balance or digest of one anywhere', () => {
    seed();
    const line = formatBalanceChainReport(report({ detail: true }))!;
    for (const value of ['500000', '480000', '490000', '20000', '10000', '1500', '2500', '4000', '999']) {
      expect(line.includes(value), value).toBe(false);
    }
  });

  it('reads through a read-only, query-only connection: the same report', () => {
    seed();
    const expected = formatBalanceChainReport(report({ detail: true }));
    repo.close();
    const readonly = new Database(file, { readonly: true, fileMustExist: true });
    try {
      readonly.pragma('query_only = ON');
      expect(formatBalanceChainReport(readBalanceChainReport(readonly, { anchorExtractors: EXTRACTORS, detail: true }))).toBe(expected);
    } finally {
      readonly.close();
    }
    repo = new SqliteStateRepo({ file, now: () => new Date(NOW) });
  });

  it('without the checking or statement-facts tables: their accounts and anchors are simply absent', () => {
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '1234', currency: 'USD' });
    const result = report();
    expect(result.stores).toEqual({ checking: 'absent', statementFacts: 'absent' });
    expect(result.accounts.map((account) => `${account.kind}:${account.state}:${account.anchors.total}`)).toEqual(['card:not-yet-checked:0']);
  });

  it('never reads a table in another shape: it is reported as conflict', () => {
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '1234', currency: 'USD' });
    db().exec('CREATE TABLE checking_accounts (id TEXT PRIMARY KEY); CREATE TABLE card_schedule_observations (id TEXT PRIMARY KEY)');
    const result = report();
    expect(result.stores).toEqual({ checking: 'conflict', statementFacts: 'conflict' });
    expect(result.accounts.map((account) => account.kind)).toEqual(['card']);
  });
});

describe('verifyCardAccountChain and the admission, as W4 runs them', () => {
  it('reads one card; null for an unknown one', () => {
    const { chase } = seed();
    expect(verifyCardAccountChain(db(), chase.id, { anchorExtractors: EXTRACTORS })?.state).toBe('balanced');
    expect(verifyCardAccountChain(db(), `card-acct-${'p'.repeat(32)}`)).toBeNull();
  });

  it('holds an import that breaks a statement period that balanced, and admits one after the last statement', () => {
    const { chase } = seed();
    const verify = () => verifyCardAccountChain(db(), chase.id, { anchorExtractors: EXTRACTORS });
    const before = verify();
    repo.importCardTransactions({ cardAccountId: chase.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-11-02', end: '2026-11-03' },
      rows: [cardRow('2026-11-03', 450)] });
    const later = verify();
    expect(admitBalanceChain({ accountKey: balanceChainAccountKey(chase.id), before, after: later, baseline: null })).toMatchObject({ hold: false, result: 'pass' });
    repo.importCardTransactions({ cardAccountId: chase.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-09-21', end: '2026-09-21' },
      rows: [cardRow('2026-09-21', 300)] });
    const broken = verify();
    expect(admitBalanceChain({ accountKey: balanceChainAccountKey(chase.id), before: later, after: broken, baseline: null })).toMatchObject({
      hold: true, code: 'balance-chain-fail', cause: 'import', reconciledThroughBefore: '2026-10-31', reconciledThroughAfter: null,
    });
  });

  it('lapses a failing step\'s pin when one of its card rows changes in place, but not for an owner\'s category or note', () => {
    const { chase } = seed();
    repo.importCardTransactions({ cardAccountId: chase.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-09-21', end: '2026-09-21' },
      rows: [cardRow('2026-09-21', 300)] });
    const pin = () => verifyCardAccountChain(db(), chase.id, { anchorExtractors: EXTRACTORS })!.steps.find((step) => step.verdict === 'fail')!.pin;
    const first = pin();
    expect(first).toMatch(/^lh1:[a-p]{64}$/);
    const id = db().prepare(`SELECT id FROM card_transactions WHERE card_account_id = ? AND transaction_date = '2026-09-20'`).pluck().get(chase.id) as string;
    const writer = new CardLedgerWriter(db(), NOW);
    writer.writeOwnerFields({ id, expectedRevision: writer.trackedRow(id)!.revision, userCategory: 'Synthetic category', notes: 'synthetic note' });
    expect(pin()).toBe(first);
    // A tracked change in place, as card sync's apply path writes one: same id, dates and class; only the amount moves.
    const row = writer.trackedRow(id)!;
    const values: TrackedValues = {
      status: row.status, transactionDate: row.transactionDate, postedDate: row.postedDate, amountMinor: row.amountMinor + 1,
      originalAmountMinor: row.originalAmountMinor, originalCurrency: row.originalCurrency, kind: row.kind, description: row.description,
      merchant: row.merchant, issuerCategory: row.issuerCategory, cardScopeId: row.cardScopeId, removedReason: row.removedReason,
      removedFromStatus: row.removedFromStatus, removedAt: row.removedAt, mergedIntoId: row.mergedIntoId, dismissedAt: row.dismissedAt,
    };
    writer.writeTrackedRow({ id, cardAccountId: row.cardAccountId, expectedRevision: row.revision, values, marker: null });
    const moved = pin();
    expect(moved).toMatch(/^lh1:[a-p]{64}$/);
    expect(moved).not.toBe(first);
  });
});
