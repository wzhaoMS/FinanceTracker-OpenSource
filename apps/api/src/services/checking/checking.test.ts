import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';

import { checkingRowKey, type CheckingImportPayload, type CheckingImportRow, type CheckingImportSegment } from '@finance-tracker/shared';

import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../../testing/scratchDir.js';
import { CheckingImportRefusal, importCheckingPayload, planCheckingImport } from './importer.js';
import { createCheckingLedgerReader } from './ledger.js';
import { CHECKING_NOT_INSTALLED, CHECKING_SCHEMA, checkingSchemaState, installCheckingSchema } from './schema.js';

// Synthetic only: made-up accounts, amounts and descriptions.
const NOW = '2026-10-22T01:00:00.000Z';
const CONTEXT = { now: NOW, goId: 'a'.repeat(32), purpose: 'copy-rehearsal' as const };

const row = (postedDate: string, amountMinor: number, description = 'SYNTHETIC ROW'): CheckingImportRow =>
  ({ postedDate, amountMinor, description, checkNumber: null, bankType: null, externalIdHash: null });
const segment = (start: string, end: string, rows: CheckingImportRow[], anchors: CheckingImportSegment['anchors'] = [], source = 'ofx'): CheckingImportSegment =>
  ({ source, coverage: { start, end }, anchors, rows });
const payload = (segments: CheckingImportSegment[], last4 = '2931'): CheckingImportPayload => ({
  format: 'holdr.checking-import', version: 1, parserVersion: 'holdr-checking-import@1.0.0',
  account: { institution: 'wellsfargo', type: 'checking', last4, label: 'Wells Fargo Everyday Checking', currency: 'USD' },
  segments,
});

/** September from a statement: opening 2,000.00, one deposit, two withdrawals, closing 2,480.00. */
const SEPTEMBER = segment('2026-09-01', '2026-09-30', [
  row('2026-09-02', 100000, 'ONLINE TRANSFER FROM SYNTHETIC SAVINGS'), row('2026-09-10', -12000, 'CHECK'), row('2026-09-20', -40000, 'CITI AUTOPAY PAYMENT ***2345 SYNTH'),
], [{ date: '2026-08-31', balanceMinor: 200000, kind: 'opening' }, { date: '2026-09-30', balanceMinor: 248000, kind: 'closing' }], 'wf-statement');
/** October from a QFX: its ledger balance carried back to 10-20. */
const OCTOBER = segment('2026-10-01', '2026-10-20', [
  row('2026-10-02', -25000, 'AMEX EPAYMENT ACH PMT 261002 W1234 SYNTH'), row('2026-10-05', 300000, 'SYNTHETIC PAYROLL'),
  row('2026-10-05', -5000, 'ZELLE TO SYNTHETIC'), row('2026-10-05', -5000, 'ATM WITHDRAWAL'),
], [{ date: '2026-10-20', balanceMinor: 513000, kind: 'ledger' }]);

let dir: string, db: Database.Database;
beforeEach(async () => {
  dir = await makeScratchDir('checking-services-');
  const file = path.join(dir, 'finance.db');
  new SqliteStateRepo({ file }).close();
  db = new Database(file);
  db.pragma('foreign_keys=ON');
});
afterEach(async () => {
  db.close();
  await removeScratchDir(dir);
});

const counts = () => Object.fromEntries(['checking_accounts', 'checking_imports', 'checking_coverage', 'checking_transactions', 'checking_balances']
  .map((table) => [table, db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()]));

describe('checking schema', () => {
  it('is absent from a database the app made, installs once, and reads as conflict when anything else holds its names', () => {
    expect(checkingSchemaState(db)).toBe('absent');
    installCheckingSchema(db);
    expect(checkingSchemaState(db)).toBe('present');
    installCheckingSchema(db);
    expect(checkingSchemaState(db)).toBe('present');
    expect(CHECKING_SCHEMA.map((object) => object.name)).toEqual(['checking_accounts', 'checking_imports', 'checking_coverage',
      'checking_transactions', 'checking_transactions_by_date', 'checking_balances']);
    db.exec('DROP INDEX checking_transactions_by_date');
    expect(checkingSchemaState(db)).toBe('conflict');
    expect(() => installCheckingSchema(db)).toThrow(/another shape/);
  });

  it('is never created by the app at boot', async () => {
    const file = path.join(dir, 'reopened.db');
    const repo = new SqliteStateRepo({ file });
    try {
      expect(checkingSchemaState(repo.internalGetDb())).toBe('absent');
    } finally {
      repo.close();
    }
  });

  it('guards its own columns: no long digit runs, no malformed ids or dates', () => {
    installCheckingSchema(db);
    importCheckingPayload(db, payload([OCTOBER]), CONTEXT);
    const [account] = createCheckingLedgerReader(db).listAccounts();
    const insert = (description: string, date = '2026-10-21') => db.prepare(`INSERT INTO checking_transactions (id, checking_account_id, import_id,
      row_key, posted_date, amount_minor, currency, description) SELECT ?, ?, id, ?, ?, 1, 'USD', ? FROM checking_imports LIMIT 1`)
      .run(`chk-txn-${'b'.repeat(32)}`, account.id, checkingRowKey('2026-10-21', 1, 0), date, description);
    expect(() => insert('CARD 4111111111111111')).toThrow();
    expect(() => insert('FINE', '2026-02-30')).toThrow();
    expect(() => db.prepare("UPDATE checking_accounts SET label = 'Checking 2931'").run()).toThrow();
  });
});

describe('checking importer', () => {
  it('refuses to plan or write before the tables are installed', () => {
    expect(() => planCheckingImport(db, payload([OCTOBER]))).toThrow(CHECKING_NOT_INSTALLED);
    expect(() => importCheckingPayload(db, payload([OCTOBER]), CONTEXT)).toThrow(CHECKING_NOT_INSTALLED);
  });

  it('creates the account on its first import, then keeps every row id through re-imports of the same days', () => {
    installCheckingSchema(db);
    const first = importCheckingPayload(db, payload([SEPTEMBER, OCTOBER]), CONTEXT);
    expect(first).toMatchObject({ code: 'checking-imported', rowsNew: 7, rowsMatched: 0, daysNew: 50, daysAlreadyCovered: 0, anchorsNew: 3,
      balanceChain: { checked: 2, gaps: 0 }, coverageAfter: [{ start: '2026-09-01', end: '2026-10-20' }] });
    const reader = createCheckingLedgerReader(db);
    const ids = reader.listRows({ from: '1900-01-01', to: '9999-12-31' }).map((entry) => entry.id);
    expect(ids).toHaveLength(7);
    expect(ids.every((id) => /^chk-txn-[a-p]{32}$/.test(id))).toBe(true);

    // The same payload again: nothing written.
    expect(importCheckingPayload(db, payload([SEPTEMBER, OCTOBER]), CONTEXT)).toMatchObject({ code: 'checking-already-imported', alreadyImported: true });
    // A CSV of October's days (other words): it agrees, adds nothing, and is recorded as coverage.
    const csv = segment('2026-10-02', '2026-10-20', OCTOBER.rows.map((entry) => ({ ...entry, description: 'OTHER WORDING' })), [], 'wf-csv');
    expect(importCheckingPayload(db, payload([csv]), CONTEXT)).toMatchObject({ code: 'checking-imported', rowsNew: 0, rowsMatched: 4, daysNew: 0 });
    // A later QFX that overlaps: only its new days are written.
    const later = segment('2026-10-15', '2026-10-25', [row('2026-10-22', -1000, 'SYNTHETIC COFFEE')], [{ date: '2026-10-25', balanceMinor: 512000, kind: 'ledger' }]);
    expect(importCheckingPayload(db, payload([later]), CONTEXT)).toMatchObject({ rowsNew: 1, rowsMatched: 0, daysNew: 5, daysAlreadyCovered: 6 });
    const after = reader.listRows({ from: '1900-01-01', to: '9999-12-31' });
    expect(after.map((entry) => entry.id).filter((id) => ids.includes(id))).toEqual(ids);
    expect(after.find((entry) => entry.date === '2026-10-02')?.description).toBe('AMEX EPAYMENT ACH PMT 261002 W1234 SYNTH');
    expect(counts()).toEqual({ checking_accounts: 1, checking_imports: 3, checking_coverage: 4, checking_transactions: 8, checking_balances: 4 });
  });

  it('refuses a payload that disagrees with a covered day, or whose balances do not follow, writing nothing', () => {
    installCheckingSchema(db);
    importCheckingPayload(db, payload([SEPTEMBER, OCTOBER]), CONTEXT);
    const before = counts();
    const missing = segment('2026-10-05', '2026-10-06', [row('2026-10-05', 300000), row('2026-10-05', -5000)]);
    const refusal = (() => { try { importCheckingPayload(db, payload([missing]), CONTEXT); } catch (error) { return error; } })() as CheckingImportRefusal;
    expect(refusal).toBeInstanceOf(CheckingImportRefusal);
    expect(refusal.code).toBe('checking-overlap-disagrees');
    expect(refusal.details).toEqual({ days: 1, dates: ['2026-10-05'] });
    const wrongBalance = segment('2026-10-21', '2026-10-22', [row('2026-10-22', -1000)], [{ date: '2026-10-22', balanceMinor: 1, kind: 'ledger' }]);
    expect(() => importCheckingPayload(db, payload([wrongBalance]), CONTEXT)).toThrow(/checking-balance-mismatch/);
    const contradicting = segment('2026-10-21', '2026-10-22', [], [{ date: '2026-10-20', balanceMinor: 1, kind: 'ledger' }]);
    expect(() => importCheckingPayload(db, payload([contradicting]), CONTEXT)).toThrow(/checking-balance-mismatch/);
    expect(counts()).toEqual(before);
    expect(() => importCheckingPayload(db, { ...payload([OCTOBER]), extra: 1 }, CONTEXT)).toThrow(/checking-payload-invalid/);
    const cardData = payload([segment('2026-11-01', '2026-11-01', [row('2026-11-01', -1, 'CARD 4111 1111 1111 1111')])]);
    expect(() => importCheckingPayload(db, cardData, CONTEXT)).toThrow(/checking-payload-card-data|checking-payload-invalid/);
    expect(counts()).toEqual(before);
  });

  it('plans read-only exactly what the import then does', () => {
    installCheckingSchema(db);
    const plan = planCheckingImport(db, payload([SEPTEMBER, OCTOBER]));
    expect(counts()).toEqual({ checking_accounts: 0, checking_imports: 0, checking_coverage: 0, checking_transactions: 0, checking_balances: 0 });
    const { code, ...receipt } = importCheckingPayload(db, payload([SEPTEMBER, OCTOBER]), CONTEXT);
    expect(code).toBe('checking-imported');
    expect(receipt).toEqual({ ...plan, account: { ...plan.account, exists: true } });
  });

  it('keeps accounts apart: the same days in another account are another record', () => {
    installCheckingSchema(db);
    importCheckingPayload(db, payload([OCTOBER]), CONTEXT);
    importCheckingPayload(db, payload([OCTOBER], '1234'), CONTEXT);
    const reader = createCheckingLedgerReader(db);
    expect(reader.listAccounts().map((account) => account.last4)).toEqual(['1234', '2931']);
    expect(reader.coverage()).toHaveLength(2);
    expect(reader.listRows({ from: '2026-10-01', to: '2026-10-31' })).toHaveLength(8);
  });
});

describe('checking ledger reader', () => {
  it('answers empty and not installed without the tables', () => {
    const reader = createCheckingLedgerReader(db);
    expect(reader.installed()).toBe(false);
    expect(reader.listAccounts()).toEqual([]);
    expect(reader.listRows({ from: '1900-01-01', to: '9999-12-31' })).toEqual([]);
    expect(reader.coverage()).toEqual([]);
    expect(() => reader.listRows({ from: '2026-1-1', to: '2026-12-31' })).toThrow(TypeError);
  });

  it('reads the agreed shapes: accounts, posted rows (money out negative) and merged coverage', () => {
    installCheckingSchema(db);
    importCheckingPayload(db, payload([SEPTEMBER, OCTOBER]), CONTEXT);
    const reader = createCheckingLedgerReader(db);
    expect(reader.installed()).toBe(true);
    const [account] = reader.listAccounts();
    expect(account).toEqual({ id: expect.stringMatching(/^chk-acct-[a-p]{32}$/), institution: 'wellsfargo', label: 'Wells Fargo Everyday Checking',
      last4: '2931', currency: 'USD', status: 'active' });
    const rows = reader.listRows({ from: '2026-09-20', to: '2026-10-02' });
    expect(rows).toEqual([
      { id: expect.any(String), checkingAccountId: account.id, date: '2026-09-20', status: 'posted', amountMinor: -40000, currency: 'USD',
        description: 'CITI AUTOPAY PAYMENT ***2345 SYNTH', checkNumber: null },
      { id: expect.any(String), checkingAccountId: account.id, date: '2026-10-02', status: 'posted', amountMinor: -25000, currency: 'USD',
        description: 'AMEX EPAYMENT ACH PMT 261002 W1234 SYNTH', checkNumber: null },
    ]);
    expect(reader.coverage()).toEqual([{ checkingAccountId: account.id, ranges: [{ start: '2026-09-01', end: '2026-10-20' }] }]);
  });
});
