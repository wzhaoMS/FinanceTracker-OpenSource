import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { cardExternalIdHash, containsCardData, containsCardSecret, luhnValid } from '@finance-tracker/shared';
import { CARD_TABLES } from './cardGuards.js';
import { cardSyncActorRef } from './cardSyncDigests.js';
import { HoldrDbError, HoldrRefusal } from './dbErrors.js';
import {
  CARD_SPENDING_V13_SCHEMA_FOR_TESTS,
  SqliteStateRepo,
  type CardImportInput,
  type CardImportRow,
} from './sqliteStateRepo.js';

// v14 spending reports: import coverage, pending → posted, edits and queries.
// Every row is synthetic: made-up merchants, amounts, references and last-4s.

let dir: string;
let repo: SqliteStateRepo;
/** The signed-in owner who edits rows in these tests. */
const OWNER = { actorRef: cardSyncActorRef('test-owner') };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-card-reports-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

/** A Luhn-valid 16-digit number made up at run time, so no card number is written in this file. */
function syntheticCardNumber(): string {
  const body = `4${'7'.repeat(14)}`;
  for (let digit = 0; digit <= 9; digit += 1) if (luhnValid(`${body}${digit}`)) return `${body}${digit}`;
  throw new Error('unreachable');
}

function row(patch: Partial<CardImportRow> = {}): CardImportRow {
  return {
    transactionDate: '2026-09-10',
    postedDate: '2026-09-11',
    status: 'posted',
    amountMinor: 1250,
    currency: 'USD',
    kind: 'purchase',
    description: 'SAMPLE COFFEE BAR',
    merchant: 'Sample Coffee',
    issuerCategory: 'Restaurant',
    ...patch,
  };
}

function importRows(cardAccountId: string, rows: CardImportRow[], patch: Partial<CardImportInput> = {}) {
  return repo.importCardTransactions({ cardAccountId, source: 'test-sync', parserVersion: 'test@1', rows, ...patch });
}

function card(patch: Record<string, unknown> = {}) {
  return repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD', ...patch } as never);
}

const byDescription = (id: string, description: string) =>
  repo.queryCardTransactions({ cardAccountId: id, search: description, statuses: ['pending', 'posted', 'removed'] }).transactions;

it('filters wallet merchant twins consistently and searches the actual row text', () => {
  const account = card();
  const names = [
    'AplPay TARGET DULUTH GA', 'TARGET 00012345 DULUTH GA', 'AplPay MICRO CENTER DULUTH GA',
    'AplPay SQ *SAMPLE CAFE', 'APLPAY', 'PAYPAL', 'PAYPAL SAMPLE SHOP', 'DULUTH', 'DULUTH SAMPLE SHOP',
    'BALTIMORE', 'BALTIMORE SAMPLE CAFE', 'SAMPLE CAFE SEATTLE', 'SAMPLE CAFE HARDWARE SEATTLE',
  ];
  importRows(account.id, names.map((description) => row({ description, merchant: null })));
  const descriptions = (query: { merchant?: string; search?: string }) =>
    repo.queryCardTransactions({ cardAccountId: account.id, ...query }).transactions.map((tx) => tx.description).sort();
  expect(descriptions({ merchant: 'TARGET DULUTH' })).toEqual(names.slice(0, 2).sort());
  expect(descriptions({ merchant: 'AplPay TARGET DULUTH GA' })).toEqual(names.slice(0, 2).sort());
  expect(descriptions({ merchant: 'SAMPLE CAFE' })).toEqual([names[3], 'SAMPLE CAFE SEATTLE'].sort());
  for (const merchant of ['APLPAY', 'PAYPAL', 'DULUTH', 'BALTIMORE']) {
    expect(descriptions({ merchant })).toEqual([merchant]);
  }
  expect(descriptions({ search: 'target' })).toEqual(names.slice(0, 2).sort());
  expect(descriptions({ search: 'micro center' })).toEqual([names[2]]);
});

function brokerageSnapshot(r: SqliteStateRepo): Record<string, unknown[]> {
  const db = r.internalGetDb();
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'card_%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((table) => table.name);
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
}

describe('schema v14', () => {
  /** A database as the v13 build (Phase 3) left it, with one card import. */
  function createV13Database(file: string): void {
    new SqliteStateRepo({ file }).close();
    const db = new Database(file);
    // Every card table this build creates (v15's too), dependents first.
    for (const table of [...CARD_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
    db.exec('PRAGMA user_version = 12;');
    db.exec(CARD_SPENDING_V13_SCHEMA_FOR_TESTS);
    db.exec(`
      INSERT INTO card_accounts (id, issuer, owner, last4, currency) VALUES ('card-acct-old', 'amex', 'joint', '0003', 'USD');
      INSERT INTO card_import_batches (id, card_account_id, source, parser_version, row_count, new_count, duplicate_count, rejected_count)
        VALUES ('card-import-old', 'card-acct-old', 'amex-csv', 'amex-csv@1', 1, 1, 0, 0);
      INSERT INTO card_transactions (id, card_account_id, source, external_id_hash, fingerprint, transaction_date, status,
        amount_minor, currency, kind, description, import_batch_id)
        VALUES ('card-txn-old', 'card-acct-old', 'amex-csv', '${cardExternalIdHash('OLD-REF')}', NULL, '2026-08-01', 'pending',
        999, 'USD', 'purchase', 'OLD PENDING CHARGE', 'card-import-old');
      PRAGMA user_version = 13;
    `);
    db.close();
  }

  it('upgrades a v13 database in place, keeping its rows and guarding the new columns', () => {
    const file = path.join(dir, 'v13.db');
    createV13Database(file);
    const upgraded = new SqliteStateRepo({ file });
    try {
      expect(upgraded.schemaVersion()).toBe(15);
      expect(upgraded.listCardImportBatches()).toEqual([expect.not.objectContaining({ coverage: expect.anything() })]);
      expect(upgraded.getCardTransaction('card-txn-old')).toMatchObject({ status: 'pending', amountMinor: 999 });
      const db = upgraded.internalGetDb();
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns('card_import_batches')).toEqual(expect.arrayContaining(['coverage_start', 'coverage_end']));
      expect(columns('card_transactions')).toEqual(expect.arrayContaining(['dismissed_at']));
      expect(() => db.prepare("UPDATE card_import_batches SET coverage_start = ?, coverage_end = ?").run('1234567890123', '2026-08-31'))
        .toThrow(/card_import_batches\.coverage_start must not contain/);
      // The old pending row posts in place when its reference arrives posted.
      importRows('card-acct-old', [row({
        externalIdHash: cardExternalIdHash('OLD-REF'), transactionDate: '2026-08-02', amountMinor: 999, description: 'OLD PENDING CHARGE',
      })]);
      expect(upgraded.getCardTransaction('card-txn-old')).toMatchObject({ status: 'posted', transactionDate: '2026-08-02' });
    } finally {
      upgraded.close();
    }
    function importRows(cardAccountId: string, rows: CardImportRow[]) {
      return upgraded.importCardTransactions({ cardAccountId, source: 'test-sync', parserVersion: 'test@1', rows });
    }
  });

  it('rolls a failed v14 upgrade back to the v13 database and closes the handle', () => {
    const file = path.join(dir, 'v13.db');
    createV13Database(file);
    const setup = new Database(file);
    setup.exec('ALTER TABLE card_transactions ADD COLUMN dismissed_at TEXT;');
    const before = setup.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    setup.close();
    const close = vi.spyOn(Database.prototype, 'close');
    try {
      // The upgrade fails on the existing column; SQLite's own message stays
      // behind the value-free boundary, which names only the operation and code.
      expect(() => new SqliteStateRepo({ file })).toThrow(/^open database failed \(SQLITE_ERROR\)$/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    const after = new Database(file);
    try {
      expect(after.pragma('user_version', { simple: true })).toBe(13);
      expect(after.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
    } finally {
      after.close();
    }
  });

  it('keeps coverage shaped and paired, and a dismissal on removed rows only', () => {
    const db = repo.internalGetDb();
    const account = card();
    const batch = importRows(account.id, [row()], { coverage: { start: '2026-09-01', end: '2026-09-30' } });
    const setCoverage = db.prepare('UPDATE card_import_batches SET coverage_start = ?, coverage_end = ? WHERE id = ?');
    for (const [start, end] of [['2026-09-01', null], [null, '2026-09-30'], ['2026-09-30', '2026-09-01'], ['2026-9-01', '2026-09-30']]) {
      expect(() => setCoverage.run(start, end, batch.id), `${start}..${end}`).toThrow(/CHECK constraint failed/);
    }
    const [stored] = repo.listCardTransactions();
    expect(stored.status).toBe('posted');
    // Each update also moves the row's revision and records how it was
    // removed (v15's invariant triggers), so the v14 CHECK is what refuses.
    expect(() => db.prepare('UPDATE card_transactions SET dismissed_at = ?, revision = revision + 1 WHERE id = ?')
      .run('2026-10-16T12:00:00.000Z', stored.id)).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(`UPDATE card_transactions SET status = 'removed', removed_reason = 'mistaken-import',
        removed_from_status = 'posted', removed_at = '2026-10-16T12:00:00.000Z', dismissed_at = ?, revision = revision + 1
      WHERE id = ?`).run('soon', stored.id)).toThrow(/CHECK constraint failed/);
  });
});

describe('five-digit account endings', () => {
  it('stores the five digits Amex shows, implies last4, and keeps them consistent', () => {
    const gold = card({ last4: undefined, last5: '90003', nickname: 'Gold' });
    const platinum = card({ last4: '0003', last5: '80003', nickname: 'Platinum' });
    expect(gold).toMatchObject({ last4: '0003', last5: '90003' });
    expect(platinum).toMatchObject({ last4: '0003', last5: '80003' });
    expect(card({ last4: '2002' }).last5).toBeUndefined();
    for (const [input, message] of [
      [{ last5: '4100' }, /^last5 must be exactly five digits$/],
      [{ last5: '900031' }, /^last5 must be exactly five digits$/],
      [{ last5: '٩٠٠٠٣' }, /^last5 must be exactly five digits$/],
      [{ last4: '9999', last5: '90003' }, /^last5 must end with the account's last four digits$/],
    ] as const) {
      expect(() => card(input), JSON.stringify(input)).toThrow(message);
    }
    expect(repo.updateCardAccount(platinum.id, { last5: null })?.last5).toBeUndefined();
    expect(repo.updateCardAccount(platinum.id, { last5: '70003' })).toMatchObject({ last4: '0003', last5: '70003' });
    expect(() => repo.updateCardAccount(platinum.id, { last5: '28182' })).toThrow(/^last5 must end with/);
    const none = card({ last4: undefined });
    expect(() => repo.updateCardAccount(none.id, { last5: '90003' })).toThrow(/^last5 must end with/);
    const db = repo.internalGetDb();
    expect(() => db.prepare('UPDATE card_accounts SET last5 = ? WHERE id = ?').run('96428', gold.id)).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare('UPDATE card_accounts SET last4 = ? WHERE id = ?').run('9999', gold.id)).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare('UPDATE card_accounts SET last5 = ? WHERE id = ?').run(90003, gold.id)).toThrow(/CHECK constraint failed/);
  });
});

describe('import coverage', () => {
  it('records the coverage of each import, allows a quiet month without rows, and refuses rows outside it', () => {
    const account = card();
    const september = importRows(account.id, [row()], { coverage: { start: '2026-09-01', end: '2026-09-30' } });
    expect(september.coverage).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    const quiet = importRows(account.id, [], { coverage: { start: '2026-10-01', end: '2026-10-31' } });
    expect(quiet).toMatchObject({ rowCount: 0, newCount: 0, duplicateCount: 0, coverage: { start: '2026-10-01', end: '2026-10-31' } });
    expect(() => importRows(account.id, [])).toThrow(/^rows must contain between 1 and/);
    expect(() => importRows(account.id, [row({ transactionDate: '2026-11-02', postedDate: '2026-11-03' })], {
      coverage: { start: '2026-11-01', end: '2026-11-02' },
    })).toThrow(/^rows\[0\] falls outside coverage$/);
    for (const coverage of [{ start: '2026-11-02', end: '2026-11-01' }, { start: '2026-02-30', end: '2026-03-01' }, { start: 'x', end: 'y' }]) {
      expect(() => importRows(account.id, [], { coverage }), JSON.stringify(coverage)).toThrow(/^coverage must be two valid/);
    }
    expect(repo.listCardImportBatches(account.id)).toHaveLength(2);
  });

  it('merges coverage per card, shows gaps, and lists imports newest first', () => {
    const amex = card();
    const chase = card({ issuer: 'chase', owner: 'casey', last4: '2002' });
    importRows(amex.id, [row({ transactionDate: '2026-07-03', postedDate: '2026-07-04' })], { coverage: { start: '2026-07-01', end: '2026-07-31' } });
    importRows(amex.id, [row({ transactionDate: '2026-08-03', postedDate: '2026-08-04' })], { coverage: { start: '2026-08-01', end: '2026-08-31' } });
    importRows(amex.id, [row({ transactionDate: '2026-10-03', postedDate: '2026-10-04' })], { coverage: { start: '2026-10-01', end: '2026-10-16' } });
    importRows(amex.id, [row({ transactionDate: '2026-10-05', postedDate: null, status: 'pending', amountMinor: 77 })]);
    const coverage = repo.listCardCoverage();
    expect(coverage.map((item) => item.cardAccountId)).toEqual([amex.id, chase.id]);
    expect(coverage[0].ranges).toEqual([{ start: '2026-07-01', end: '2026-08-31' }, { start: '2026-10-01', end: '2026-10-16' }]);
    expect(coverage[0].transactions).toEqual({ count: 4, first: '2026-07-03', last: '2026-10-05' });
    expect(coverage[0].imports.map((batch) => batch.coverage?.start ?? null)).toEqual([null, '2026-10-01', '2026-08-01', '2026-07-01']);
    expect(coverage[1]).toEqual({ cardAccountId: chase.id, ranges: [], transactions: null, imports: [] });
    expect(repo.cardCoverageCovers(amex.id, { start: '2026-07-15', end: '2026-08-15' })).toBe(true);
    expect(repo.cardCoverageCovers(amex.id, { start: '2026-08-15', end: '2026-09-02' })).toBe(false);
    expect(repo.cardCoverageCovers(chase.id, { start: '2026-08-15', end: '2026-08-15' })).toBe(false);
  });
});

describe('pending → posted', () => {
  it('turns a pending row into the posted row when its issuer reference arrives posted, keeping its id and edits', () => {
    const account = card();
    const reference = cardExternalIdHash('SYN-REF-1');
    importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null })]);
    const [pending] = repo.listCardTransactions();
    repo.updateCardTransaction(pending.id, { userCategory: 'Coffee', notes: 'with a friend' }, OWNER);
    const batch = importRows(account.id, [row({ externalIdHash: reference, postedDate: '2026-09-12' })]);
    expect(batch).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.listCardTransactions()).toEqual([
      expect.objectContaining({ id: pending.id, status: 'posted', postedDate: '2026-09-12', userCategory: 'Coffee', notes: 'with a friend' }),
    ]);
    // Posted rows never go back to pending.
    importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null })]);
    expect(repo.getCardTransaction(pending.id)?.status).toBe('posted');
  });

  it('posts a pending row on a fingerprint match only when told to, since occurrence numbers shift', () => {
    const account = card();
    importRows(account.id, [row({ status: 'pending', postedDate: null })]);
    const [pending] = repo.listCardTransactions();
    // Same date, amount and description, no reference: a duplicate unless the owner says it posted.
    importRows(account.id, [row({ postedDate: '2026-09-12' })]);
    expect(repo.getCardTransaction(pending.id)?.status).toBe('pending');
    importRows(account.id, [row({ postedDate: '2026-09-12' })], { promoteFingerprintMatches: true });
    expect(repo.listCardTransactions()).toEqual([expect.objectContaining({ id: pending.id, status: 'posted', postedDate: '2026-09-12' })]);
    expect(() => importRows(account.id, [row()], { promoteFingerprintMatches: 'yes' as never })).toThrow(/^promoteFingerprintMatches must be true or false$/);
  });

  it('does not count a posted purchase twice when a later export shifts the fingerprint onto a pending row', () => {
    const account = card();
    // Two reference-less $50 purchases with the same date and text: A still pending, B posted.
    importRows(account.id, [
      row({ status: 'pending', postedDate: null, amountMinor: 5000, description: 'SAMPLE BISTRO' }),
      row({ amountMinor: 5000, description: 'SAMPLE BISTRO' }),
    ]);
    // A posted-only export with just B: B now takes the first occurrence, A's fingerprint.
    importRows(account.id, [row({ amountMinor: 5000, description: 'SAMPLE BISTRO' })]);
    expect(repo.listCardTransactions().map((item) => item.status).sort()).toEqual(['pending', 'posted']);
  });

  it('takes the posted amount when a stable reference posts with a tip added', () => {
    const account = card();
    const reference = cardExternalIdHash('SYN-TIP-1');
    importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null, amountMinor: 4000, description: 'SAMPLE BISTRO' })]);
    importRows(account.id, [row({ externalIdHash: reference, amountMinor: 4800, description: 'SAMPLE BISTRO SEATTLE', postedDate: '2026-09-12' })]);
    expect(repo.listCardTransactions()).toEqual([
      expect.objectContaining({ status: 'posted', amountMinor: 4800, description: 'SAMPLE BISTRO SEATTLE', externalIdHash: reference }),
    ]);
  });

  it('leaves a pending row pending when a posted row arrives under another reference, and only suggests it', () => {
    const account = card();
    importRows(account.id, [row({ externalIdHash: cardExternalIdHash('PEND-1'), status: 'pending', postedDate: null, description: 'SQ *SAMPLE COFFEE' })]);
    const [pending] = repo.listCardTransactions();
    repo.updateCardTransaction(pending.id, { userCategory: 'Coffee', notes: 'synthetic note' }, OWNER);
    importRows(account.id, [row({ externalIdHash: cardExternalIdHash('POST-1'), transactionDate: '2026-09-11', postedDate: '2026-09-12' })]);
    const posted = repo.listCardTransactions().find((item) => item.status === 'posted')!;
    // Same amount and dates prove nothing: nothing changes, the owner judges the suggestion.
    expect(repo.getCardTransaction(pending.id)).toMatchObject({ status: 'pending', userCategory: 'Coffee', notes: 'synthetic note' });
    expect(posted).toMatchObject({ userCategory: undefined, notes: undefined });
    expect(repo.listPossiblePostedCardVersions(pending.id).map((item) => item.id)).toEqual([posted.id]);
    expect(repo.listPossiblePostedCardVersions(posted.id)).toEqual([]);
  });

  it('never loses a purchase that is still pending when an unrelated posted row of the same amount arrives', () => {
    const account = card();
    const pendingA = row({ externalIdHash: cardExternalIdHash('A'), status: 'pending', postedDate: null, amountMinor: 5000, description: 'SAMPLE BISTRO' });
    importRows(account.id, [pendingA]);
    // The next snapshot still shows A pending, next to another $50 purchase that posted.
    importRows(account.id, [pendingA, row({ externalIdHash: cardExternalIdHash('B'), amountMinor: 5000, description: 'SAMPLE BOOKS' })]);
    // Then A posts under its own reference.
    importRows(account.id, [row({ externalIdHash: cardExternalIdHash('A'), amountMinor: 5000, description: 'SAMPLE BISTRO', postedDate: '2026-09-13' })]);
    expect(repo.listCardTransactions().map((item) => [item.description, item.status])).toEqual([
      ['SAMPLE BISTRO', 'posted'],
      ['SAMPLE BOOKS', 'posted'],
    ]);
  });

  it('suggests same-amount posted rows of other imports from 2 days before to 10 days after, same description first, then the closest date', () => {
    const account = card();
    const other = card({ last4: '8409' });
    importRows(account.id, [
      row({ externalIdHash: cardExternalIdHash('P'), status: 'pending', postedDate: null, transactionDate: '2026-09-08' }),
      // Posted in the same import as the pending row: both were current then.
      row({ externalIdHash: cardExternalIdHash('S'), transactionDate: '2026-09-09' }),
    ]);
    importRows(account.id, [
      row({ externalIdHash: cardExternalIdHash('X'), transactionDate: '2026-09-10', description: 'OTHER PLACE' }),
      row({ externalIdHash: cardExternalIdHash('Y'), transactionDate: '2026-09-12', postedDate: '2026-09-13', description: 'SAMPLE COFFEE BAR' }),
      row({ externalIdHash: cardExternalIdHash('Z'), transactionDate: '2026-09-09', description: 'ELSEWHERE' }),
      row({ externalIdHash: cardExternalIdHash('W'), transactionDate: '2026-09-19', postedDate: '2026-09-20', description: 'TOO LATE' }),
      row({ externalIdHash: cardExternalIdHash('V'), transactionDate: '2026-09-05', postedDate: '2026-09-06', description: 'TOO EARLY' }),
      row({ externalIdHash: cardExternalIdHash('U'), transactionDate: '2026-09-10', amountMinor: 1300, description: 'OTHER AMOUNT' }),
      row({ externalIdHash: cardExternalIdHash('Q'), transactionDate: '2026-09-10', status: 'pending', postedDate: null, description: 'STILL PENDING' }),
    ]);
    importRows(other.id, [row({ externalIdHash: cardExternalIdHash('O'), transactionDate: '2026-09-10', description: 'OTHER CARD' })]);
    const pending = byDescription(account.id, 'sample coffee bar').find((item) => item.status === 'pending')!;
    expect(repo.listPossiblePostedCardVersions(pending.id).map((item) => item.description)).toEqual(['SAMPLE COFFEE BAR', 'ELSEWHERE', 'OTHER PLACE']);
    expect(repo.listPossiblePostedCardVersions(pending.id, 10).map((item) => item.description)).toEqual(['SAMPLE COFFEE BAR', 'ELSEWHERE', 'OTHER PLACE']);
    expect(repo.listPossiblePostedCardVersions('card-txn-missing')).toEqual([]);
  });

  it('keeps a dismissed pending row dismissed when its posted version arrives, unless the owner says it posted', () => {
    const account = card();
    const reference = cardExternalIdHash('SYN-REF-2');
    importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null })]);
    const [pending] = repo.listCardTransactions();
    repo.updateCardTransaction(pending.id, { userCategory: 'Coffee', notes: 'synthetic note' }, OWNER);
    const dismissed = repo.updateCardTransaction(pending.id, { status: 'removed' }, OWNER);
    expect(dismissed).toMatchObject({ status: 'removed', dismissedAt: '2026-10-16T12:00:00.000Z' });
    // Its reference arriving, pending or posted, is a duplicate: undoing a dismissal is the owner's call.
    expect(importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null })]))
      .toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(importRows(account.id, [row({ externalIdHash: reference, postedDate: '2026-09-12' })]))
      .toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.getCardTransaction(pending.id)).toEqual(dismissed);
    // The decision on fingerprint matches is not this one, and a pending row never posts it.
    importRows(account.id, [row({ externalIdHash: reference, postedDate: '2026-09-12' })], { promoteFingerprintMatches: true });
    importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null })], { promoteDismissedMatches: true });
    expect(repo.getCardTransaction(pending.id)).toEqual(dismissed);
    importRows(account.id, [row({ externalIdHash: reference, postedDate: '2026-09-12', amountMinor: 1400 })], { promoteDismissedMatches: true });
    expect(repo.listCardTransactions()).toEqual([expect.objectContaining({
      id: pending.id, status: 'posted', postedDate: '2026-09-12', amountMinor: 1400, dismissedAt: undefined,
      userCategory: 'Coffee', notes: 'synthetic note',
    })]);
    expect(() => importRows(account.id, [row()], { promoteDismissedMatches: 'yes' as never })).toThrow(/^promoteDismissedMatches must be true or false$/);
  });

  it('posts a dismissed row on a fingerprint match only on the fingerprint decision', () => {
    const account = card();
    importRows(account.id, [row({ status: 'pending', postedDate: null })]);
    const [pending] = repo.listCardTransactions();
    const dismissed = repo.updateCardTransaction(pending.id, { status: 'removed' }, OWNER);
    importRows(account.id, [row({ postedDate: '2026-09-12' })]);
    importRows(account.id, [row({ postedDate: '2026-09-12' })], { promoteDismissedMatches: true });
    expect(repo.getCardTransaction(pending.id)).toEqual(dismissed);
    importRows(account.id, [row({ postedDate: '2026-09-12' })], { promoteFingerprintMatches: true });
    expect(repo.listCardTransactions()).toEqual([expect.objectContaining({ id: pending.id, status: 'posted', postedDate: '2026-09-12', dismissedAt: undefined })]);
  });

  it('adds a fingerprint match as another purchase on the owner\'s word, under an occurrence no stored or incoming row uses', () => {
    const account = card();
    importRows(account.id, [row({ status: 'pending', postedDate: null, amountMinor: 5000, description: 'SAMPLE HOTEL' })]);
    const [pending] = repo.listCardTransactions();
    // Two posted rows like it: the first carries the pending row's fingerprint, the second the next occurrence.
    const posted = row({ amountMinor: 5000, description: 'SAMPLE HOTEL', postedDate: '2026-09-12' });
    const batch = importRows(account.id, [posted, posted], { insertFingerprintMatches: true });
    expect(batch).toMatchObject({ newCount: 2, duplicateCount: 0 });
    const rows = repo.listCardTransactions();
    expect(rows.map((item) => item.status).sort()).toEqual(['pending', 'posted', 'posted']);
    expect(new Set(rows.map((item) => item.fingerprint)).size).toBe(3);
    expect(repo.getCardTransaction(pending.id)).toMatchObject({ status: 'pending', postedDate: undefined });
    // The same export again: the second row is a duplicate, and the first matches the pending row again.
    expect(importRows(account.id, [posted, posted])).toMatchObject({ newCount: 0, duplicateCount: 2 });
    expect(() => importRows(account.id, [posted], { insertFingerprintMatches: true, promoteFingerprintMatches: true }))
      .toThrow(/^a fingerprint match is either posted or inserted, not both$/);
    expect(() => importRows(account.id, [posted], { insertFingerprintMatches: 'yes' as never }))
      .toThrow(/^insertFingerprintMatches must be true or false$/);
    // A reference match is identity: the insert decision never applies to it.
    const reference = cardExternalIdHash('SYN-HOLD-9');
    importRows(account.id, [row({ externalIdHash: reference, status: 'pending', postedDate: null, amountMinor: 700 })]);
    expect(importRows(account.id, [row({ externalIdHash: reference, amountMinor: 700 })], { insertFingerprintMatches: true }))
      .toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.listCardTransactions().filter((item) => item.externalIdHash === reference)).toEqual([
      expect.objectContaining({ status: 'posted', amountMinor: 700 }),
    ]);
  });

  it('dismisses the pending rows the owner names with an import, all or nothing', () => {
    const account = card();
    const other = card({ last4: '8409' });
    importRows(account.id, [
      row({ externalIdHash: cardExternalIdHash('HOLD-1'), status: 'pending', postedDate: null, description: 'SAMPLE ORDER' }),
      row({ externalIdHash: cardExternalIdHash('HOLD-2'), status: 'pending', postedDate: null, description: 'SAMPLE GROCER' }),
    ]);
    importRows(other.id, [row({ externalIdHash: cardExternalIdHash('HOLD-3'), status: 'pending', postedDate: null })]);
    const [order, grocer] = repo.listCardTransactions({ cardAccountId: account.id });
    const [elsewhere] = repo.listCardTransactions({ cardAccountId: other.id });
    const before = repo.listCardTransactions();
    const statement = [row({ externalIdHash: cardExternalIdHash('POST-1'), description: 'SAMPLE BAKERY' })];
    // Another card's row, or a row that is not pending, undoes the whole import.
    for (const ids of [[order.id, elsewhere.id], [order.id, 'card-txn-missing']]) {
      expect(() => importRows(account.id, statement, { dismissPendingIds: ids }))
        .toThrow(/^a pending row to dismiss is no longer pending in this card account; preview the import again$/);
      expect(repo.listCardTransactions()).toEqual(before);
      expect(repo.listCardImportBatches(account.id)).toHaveLength(1);
    }
    for (const ids of ['x', ['not an id!'], [7]]) {
      expect(() => importRows(account.id, statement, { dismissPendingIds: ids as never }))
        .toThrow(/^dismissPendingIds must be a list of card transaction ids$/);
    }
    const batch = importRows(account.id, statement, { dismissPendingIds: [order.id, order.id] });
    expect(batch).toMatchObject({ newCount: 1, duplicateCount: 0 });
    expect(repo.getCardTransaction(order.id)).toMatchObject({ status: 'removed', dismissedAt: '2026-10-16T12:00:00.000Z' });
    expect(repo.getCardTransaction(grocer.id)?.status).toBe('pending');
    // Dismissed and kept: its reference arriving pending again is a duplicate.
    expect(importRows(account.id, [row({ externalIdHash: cardExternalIdHash('HOLD-1'), status: 'pending', postedDate: null, description: 'SAMPLE ORDER' })]))
      .toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.getCardTransaction(order.id)?.status).toBe('removed');
  });

  it('posts fingerprint matches row by row on the owner\'s word, skips the rest, and writes nothing if a listed row is no match', () => {
    const account = card();
    const bistro = { amountMinor: 5000, description: 'SAMPLE BISTRO' };
    const cinema = { amountMinor: 7000, description: 'SAMPLE CINEMA' };
    importRows(account.id, [
      row({ ...bistro, status: 'pending', postedDate: null }), row({ ...cinema, status: 'pending', postedDate: null }),
    ]);
    const [bistroPending, cinemaPending] = ['SAMPLE BISTRO', 'SAMPLE CINEMA']
      .map((description) => repo.listCardTransactions().find((item) => item.description === description)!);
    const statement = [row(bistro), row(cinema), row({ amountMinor: 900, description: 'SAMPLE BAKERY' })];
    const before = repo.listCardTransactions();
    // Row 2 is new, not a match: nothing is written.
    expect(() => importRows(account.id, statement, { promoteFingerprintMatchRows: [0, 2] }))
      .toThrow(/^a row to post as its pending row is not a fingerprint match of one; preview the import again$/);
    expect(repo.listCardTransactions()).toEqual(before);
    for (const rows of ['0', [3], [-1], [0.5]]) {
      expect(() => importRows(account.id, statement, { promoteFingerprintMatchRows: rows as never }))
        .toThrow(/^promoteFingerprintMatchRows must be a list of row indexes$/);
    }
    for (const decision of [{ promoteFingerprintMatches: true }, { insertFingerprintMatches: true }]) {
      expect(() => importRows(account.id, statement, { ...decision, promoteFingerprintMatchRows: [0] }))
        .toThrow(/^fingerprint matches are posted either all or row by row, not both$/);
    }
    const batch = importRows(account.id, statement, { promoteFingerprintMatchRows: [0, 0] });
    expect(batch).toMatchObject({ newCount: 1, duplicateCount: 2 });
    expect(repo.getCardTransaction(bistroPending.id)).toMatchObject({ status: 'posted', postedDate: '2026-09-11' });
    expect(repo.getCardTransaction(cinemaPending.id)?.status).toBe('pending');
  });
});

describe('editing card transactions', () => {
  it('matches a pending row to its posted row: dismissed and kept, its edits filling the posted row\'s empty ones', () => {
    const account = card();
    const other = card({ last4: '8409' });
    const hold = row({ externalIdHash: cardExternalIdHash('AUTH-5'), status: 'pending', postedDate: null, description: 'SQ *SAMPLE COFFEE' });
    importRows(account.id, [hold]);
    importRows(account.id, [
      row({ externalIdHash: cardExternalIdHash('POST-5'), postedDate: '2026-09-12' }),
      row({ externalIdHash: cardExternalIdHash('POST-6'), postedDate: '2026-09-12', description: 'SAMPLE TEA' }),
    ]);
    importRows(other.id, [row({ externalIdHash: cardExternalIdHash('POST-7') })]);
    const pending = repo.listCardTransactions({ cardAccountId: account.id }).find((item) => item.status === 'pending')!;
    const [posted, tea] = repo.listCardTransactions({ cardAccountId: account.id }).filter((item) => item.status === 'posted');
    const [elsewhere] = repo.listCardTransactions({ cardAccountId: other.id });
    repo.updateCardTransaction(pending.id, { userCategory: 'Coffee', notes: 'synthetic note' }, OWNER);
    repo.updateCardTransaction(posted.id, { notes: 'its own note' }, OWNER);
    const before = repo.listCardTransactions();
    for (const [target, message] of [
      [pending.id, /^postedAs must be a posted transaction of the same card account and currency$/],
      [elsewhere.id, /^postedAs must be a posted transaction of the same card account and currency$/],
      ['card-txn-missing', /^postedAs must be a posted transaction of the same card account and currency$/],
      ['not an id!', /^postedAs must be a card transaction id$/],
    ] as const) {
      expect(() => repo.updateCardTransaction(pending.id, { postedAs: target }, OWNER)).toThrow(message);
    }
    expect(() => repo.updateCardTransaction(pending.id, { postedAs: posted.id, notes: 'x' }, OWNER)).toThrow(/^postedAs cannot be combined with other changes$/);
    expect(() => repo.updateCardTransaction(tea.id, { postedAs: posted.id }, OWNER)).toThrow(/^only a pending card transaction can be matched to its posted row$/);
    expect(repo.listCardTransactions()).toEqual(before);

    const merged = repo.updateCardTransaction(pending.id, { postedAs: posted.id }, OWNER);
    expect(merged).toMatchObject({ id: pending.id, status: 'removed', dismissedAt: '2026-10-16T12:00:00.000Z', userCategory: 'Coffee', notes: 'synthetic note' });
    expect(repo.getCardTransaction(posted.id)).toMatchObject({ status: 'posted', userCategory: 'Coffee', notes: 'its own note' });
    expect(repo.getCardTransaction(tea.id)).toMatchObject({ userCategory: undefined, notes: undefined });
    // Kept: its reference arriving pending again is a duplicate; the owner can still restore it.
    expect(importRows(account.id, [hold])).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.getCardTransaction(pending.id)?.status).toBe('removed');
    expect(repo.updateCardTransaction(pending.id, { status: 'pending' }, OWNER)).toMatchObject({ status: 'pending', dismissedAt: undefined });
  });
  it('sets and clears custom categories and notes, refusing card data, digit runs and control characters', () => {
    const account = card();
    importRows(account.id, [row()]);
    const [stored] = repo.listCardTransactions();
    expect(repo.updateCardTransaction(stored.id, { userCategory: '  Coffee  ', notes: 'synthetic' }, OWNER)).toMatchObject({
      userCategory: 'Coffee', notes: 'synthetic', amountMinor: 1250, description: 'SAMPLE COFFEE BAR', status: 'posted',
    });
    expect(repo.updateCardTransaction(stored.id, { notes: null }, OWNER)).toMatchObject({ userCategory: 'Coffee', notes: undefined });
    expect(repo.updateCardTransaction(stored.id, { userCategory: '' }, OWNER)?.userCategory).toBeUndefined();
    const pan = syntheticCardNumber();
    for (const [patch, message] of [
      [{ notes: `card ${pan}` }, /^notes must not contain a card number/],
      [{ userCategory: `x${'1'.repeat(13)}` }, /^userCategory must not contain a card number or 13/],
      [{ notes: 'a\u0007b' }, /^notes must not contain control characters$/],
      [{ userCategory: 'c'.repeat(101) }, /^userCategory must be at most 100 characters$/],
      [{ notes: 42 }, /^notes must be a string$/],
    ] as const) {
      expect(() => repo.updateCardTransaction(stored.id, patch as never, OWNER), JSON.stringify(Object.keys(patch))).toThrow(message);
    }
    expect(repo.updateCardTransaction('card-txn-missing', { notes: 'x' }, OWNER)).toBeNull();
    expect(repo.getCardTransaction(stored.id)).toMatchObject({ userCategory: undefined, notes: undefined });
  });

  it('dismisses and restores pending rows, and refuses other status changes', () => {
    const account = card();
    importRows(account.id, [row({ status: 'pending', postedDate: null }), row({ amountMinor: 999, description: 'POSTED THING' })]);
    const pending = repo.listCardTransactions().find((item) => item.status === 'pending')!;
    const posted = repo.listCardTransactions().find((item) => item.status === 'posted')!;
    expect(repo.updateCardTransaction(pending.id, { status: 'removed' }, OWNER)).toMatchObject({ status: 'removed', dismissedAt: '2026-10-16T12:00:00.000Z' });
    expect(repo.updateCardTransaction(pending.id, { status: 'removed' }, OWNER)).toMatchObject({ status: 'removed' });
    expect(repo.updateCardTransaction(pending.id, { status: 'pending' }, OWNER)).toMatchObject({ status: 'pending', dismissedAt: undefined });
    expect(() => repo.updateCardTransaction(posted.id, { status: 'removed' }, OWNER)).toThrow(/^only a pending card transaction can be dismissed$/);
    expect(() => repo.updateCardTransaction(posted.id, { status: 'pending' }, OWNER)).toThrow(/^only a dismissed pending card transaction can be restored$/);
    expect(() => repo.updateCardTransaction(posted.id, { status: 'posted' } as never, OWNER)).toThrow(/^status must be pending or removed$/);

    // An import cannot declare a removed row (v15, Q22): what a source showed
    // is pending or posted, and only an owner's decision removes a row. The
    // removed rows that are not dismissals are v14's legacy removals, which
    // sqliteStateRepo.cardSync.test.ts shows are not restorable here either.
    expect(() => importRows(account.id, [row({ status: 'removed', postedDate: null, amountMinor: 55, description: 'ISSUER REMOVED' })]))
      .toThrow(/^rows\[0\]\.status must be pending or posted$/);
    expect(byDescription(account.id, 'issuer removed')).toEqual([]);
  });
});

describe('querying card transactions', () => {
  function seed() {
    const amex = card({ nickname: 'Gold' });
    const chase = card({ issuer: 'chase', owner: 'casey', last4: '2002' });
    const yen = card({ issuer: 'samplebank', owner: 'joint', last4: '3003', currency: 'JPY' });
    importRows(amex.id, [
      row({ transactionDate: '2026-09-01', amountMinor: 1250, issuerCategory: 'Restaurant', description: 'SAMPLE COFFEE BAR' }),
      row({ transactionDate: '2026-09-05', amountMinor: 12999, issuerCategory: 'Merchandise', description: 'SAMPLE OUTFITTERS', merchant: null }),
      row({ transactionDate: '2026-09-20', amountMinor: -2500, kind: 'refund', issuerCategory: 'Merchandise', description: 'SAMPLE OUTFITTERS RETURN', merchant: null }),
      row({ transactionDate: '2026-09-25', amountMinor: -50000, kind: 'payment', issuerCategory: null, description: 'AUTOPAY PAYMENT THANK YOU', merchant: null }),
      row({ transactionDate: '2026-10-02', postedDate: null, status: 'pending', amountMinor: 640, description: 'SAMPLE COFFEE BAR' }),
    ]);
    importRows(chase.id, [
      row({ transactionDate: '2026-09-03', amountMinor: 4567, issuerCategory: null, description: 'NORTHWIND GROCERY', merchant: 'Northwind' }),
      row({ transactionDate: '2026-09-28', amountMinor: 1234, issuerCategory: 'Travel', description: 'CONTOSO RAIL' }),
    ]);
    importRows(yen.id, [row({ currency: 'JPY', transactionDate: '2026-09-15', amountMinor: 1234, issuerCategory: 'Travel', description: 'SAMPLE TEMPLE SHOP' })]);
    return { amex, chase, yen };
  }
  const descriptions = (query: Parameters<SqliteStateRepo['queryCardTransactions']>[0], page = {}) =>
    repo.queryCardTransactions(query, page).transactions.map((item) => item.description);

  it('filters by card, owner, status, kind, dates, category and merchant', () => {
    const { amex, chase } = seed();
    expect(descriptions({})).toEqual([
      'SAMPLE COFFEE BAR', 'CONTOSO RAIL', 'AUTOPAY PAYMENT THANK YOU', 'SAMPLE OUTFITTERS RETURN', 'SAMPLE TEMPLE SHOP',
      'SAMPLE OUTFITTERS', 'NORTHWIND GROCERY', 'SAMPLE COFFEE BAR',
    ]);
    expect(descriptions({ cardAccountId: chase.id })).toEqual(['CONTOSO RAIL', 'NORTHWIND GROCERY']);
    expect(descriptions({ owner: 'joint' })).toEqual(['SAMPLE TEMPLE SHOP']);
    expect(descriptions({ statuses: ['pending'] })).toEqual(['SAMPLE COFFEE BAR']);
    expect(descriptions({ kinds: ['refund', 'payment'] })).toEqual(['AUTOPAY PAYMENT THANK YOU', 'SAMPLE OUTFITTERS RETURN']);
    expect(descriptions({ from: '2026-09-05', to: '2026-09-20', cardAccountId: amex.id })).toEqual(['SAMPLE OUTFITTERS RETURN', 'SAMPLE OUTFITTERS']);
    expect(descriptions({ category: 'Merchandise' })).toEqual(['SAMPLE OUTFITTERS RETURN', 'SAMPLE OUTFITTERS']);
    expect(descriptions({ category: 'Uncategorized' })).toEqual(['AUTOPAY PAYMENT THANK YOU', 'NORTHWIND GROCERY']);
    expect(descriptions({ merchant: 'Northwind' })).toEqual(['NORTHWIND GROCERY']);
    // A merchant group: the name's key and descriptors that extend it word by word.
    expect(descriptions({ merchant: 'SAMPLE OUTFITTERS' })).toEqual(['SAMPLE OUTFITTERS RETURN', 'SAMPLE OUTFITTERS']);
    expect(descriptions({ merchant: 'Sample Outfitters Inc.' })).toEqual(['SAMPLE OUTFITTERS RETURN', 'SAMPLE OUTFITTERS']);
    expect(descriptions({ merchant: 'SAMPLE OUTFITTERS RETURN' })).toEqual(['SAMPLE OUTFITTERS RETURN']);
    expect(descriptions({ merchant: 'SAMPLE OUTFIT' })).toEqual([]);

    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    repo.updateCardTransaction(grocery.id, { userCategory: 'Groceries' }, OWNER);
    expect(descriptions({ category: 'Groceries' })).toEqual(['NORTHWIND GROCERY']);
    expect(descriptions({ category: 'Uncategorized' })).toEqual(['AUTOPAY PAYMENT THANK YOU']);
  });

  it('searches text in any field and plain amounts in each currency', () => {
    seed();
    expect(descriptions({ search: 'outfitters' })).toEqual(['SAMPLE OUTFITTERS RETURN', 'SAMPLE OUTFITTERS']);
    expect(descriptions({ search: 'northwind' })).toEqual(['NORTHWIND GROCERY']);
    expect(descriptions({ search: 'TRAVEL' })).toEqual(['CONTOSO RAIL', 'SAMPLE TEMPLE SHOP']);
    expect(descriptions({ search: '129.99' })).toEqual(['SAMPLE OUTFITTERS']);
    expect(descriptions({ search: '$25' })).toEqual(['SAMPLE OUTFITTERS RETURN']);
    // 1234 means $12.34 on a dollar card and ¥1,234 on a yen card.
    expect(descriptions({ search: '12.34' })).toEqual(['CONTOSO RAIL']);
    expect(descriptions({ search: '1234' })).toEqual(['SAMPLE TEMPLE SHOP']);
    const notes = repo.queryCardTransactions({ search: 'contoso' }).transactions[0];
    repo.updateCardTransaction(notes.id, { notes: 'Work trip, expense it' }, OWNER);
    expect(descriptions({ search: 'EXPENSE' })).toEqual(['CONTOSO RAIL']);
    expect(() => repo.queryCardTransactions({ search: syntheticCardNumber() })).toThrow(/^search must not contain a card number/);
  });

  it('sorts and pages, counting every match', () => {
    seed();
    const first = repo.queryCardTransactions({}, { sort: 'amount-desc', limit: 3 });
    expect(first.total).toBe(8);
    expect(first.transactions.map((item) => item.amountMinor)).toEqual([12999, 4567, 1250]);
    expect(repo.queryCardTransactions({}, { sort: 'amount-desc', limit: 3, offset: 6 }).transactions.map((item) => item.amountMinor))
      .toEqual([-2500, -50000]);
    expect(descriptions({}, { sort: 'date-asc', limit: 2 })).toEqual(['SAMPLE COFFEE BAR', 'NORTHWIND GROCERY']);
    expect(repo.queryCardTransactions({}, { sort: 'amount-asc', limit: 1 }).transactions[0].amountMinor).toBe(-50000);
    expect(() => repo.queryCardTransactions({}, { limit: 0 })).toThrow(/^limit must be an integer from 1 to 200$/);
    expect(() => repo.queryCardTransactions({}, { limit: 201 })).toThrow(/^limit must be/);
    expect(() => repo.queryCardTransactions({}, { offset: -1 })).toThrow(/^offset must be/);
    expect(() => repo.queryCardTransactions({}, { sort: 'random' as never })).toThrow(/^sort must be/);
    expect(() => repo.queryCardTransactions({ from: '2026-02-30' })).toThrow(/^from must be a valid/);
    expect(() => repo.queryCardTransactions({ from: '2026-09-02', to: '2026-09-01' })).toThrow(/^from must not be after to$/);
    expect(() => repo.queryCardTransactions({ statuses: [] })).toThrow(/^statuses must be/);
    expect(() => repo.queryCardTransactions({ kinds: ['gift' as never] })).toThrow(/^kinds must be/);
    expect(() => repo.queryCardTransactions({ owner: 'jane' as never })).toThrow(/^owner must be/);
  });

  it('lists the categories in use', () => {
    seed();
    const travel = repo.queryCardTransactions({ search: 'contoso' }).transactions[0];
    repo.updateCardTransaction(travel.id, { userCategory: 'Commute' }, OWNER);
    expect(repo.listCardCategories()).toEqual(['Commute', 'Merchandise', 'Restaurant', 'Travel']);
  });
});

describe('value-free database errors', () => {
  // Phase 2's boundary (dbErrors.ts) covers the v14 methods too: SQLite's own
  // text never leaves them, and their own refusals pass unchanged.
  const pan = syntheticCardNumber();
  const PLANTED = [pan, `pan_${pan}`, 'CVV 123'];

  function caught(fn: () => unknown): Error {
    try {
      fn();
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a failure');
  }

  function expectValueFreeDbError(error: Error, operation: string, code: string): void {
    expect(error).toBeInstanceOf(HoldrDbError);
    expect(error).toMatchObject({ message: `${operation} failed (${code})`, operation, code });
    expect('cause' in error).toBe(false);
    for (const text of [error.message, String(error.stack), JSON.stringify(error)]) {
      for (const value of PLANTED) expect(text).not.toContain(value);
      expect(containsCardData(text), text).toBe(false);
      expect(containsCardSecret(text), text).toBe(false);
    }
  }

  it('quotes nothing of a foreign trigger that stops an edit, and leaves the row as it was', () => {
    const account = card();
    importRows(account.id, [row(), row({ status: 'pending', postedDate: null, externalIdHash: cardExternalIdHash('P-1'), description: 'PENDING ONE' })]);
    const [posted] = repo.queryCardTransactions({ statuses: ['posted'] }).transactions;
    const [pending] = repo.queryCardTransactions({ statuses: ['pending'] }).transactions;
    const db = repo.internalGetDb();
    db.exec(`CREATE TRIGGER foreign_edit BEFORE UPDATE ON card_transactions BEGIN SELECT RAISE(ABORT, 'CVV 123 ${pan}'); END`);
    expectValueFreeDbError(caught(() => repo.updateCardTransaction(posted.id, { notes: 'synthetic' }, OWNER)),
      'update card transaction', 'SQLITE_CONSTRAINT_TRIGGER');
    expectValueFreeDbError(caught(() => repo.updateCardTransaction(pending.id, { status: 'removed' }, OWNER)),
      'update card transaction', 'SQLITE_CONSTRAINT_TRIGGER');
    db.exec('DROP TRIGGER foreign_edit');
    expect(repo.getCardTransaction(posted.id)).toEqual(posted);
    expect(repo.getCardTransaction(pending.id)).toEqual(pending);
  });

  it('passes its own refusals through unchanged', () => {
    const account = card();
    importRows(account.id, [row()]);
    const [posted] = repo.listCardTransactions();
    for (const [fn, message] of [
      [() => repo.updateCardTransaction(posted.id, { status: 'removed' }, OWNER), 'only a pending card transaction can be dismissed'],
      [() => repo.queryCardTransactions({ from: '2026-13-01' }), 'from must be a valid YYYY-MM-DD date'],
      [() => repo.queryCardTransactions({}, { limit: 0 }), 'limit must be an integer from 1 to 200'],
      [() => repo.listCardTransactionsMatching({ owner: 'nobody' as never }), 'owner must be alex, casey or joint'],
      [() => importRows(account.id, [row({ transactionDate: '2026-10-02', postedDate: null })], { coverage: { start: '2026-09-01', end: '2026-09-30' } }),
        'rows[0] falls outside coverage'],
      [() => card({ last5: '96428' }), 'last5 must end with the account\'s last four digits'],
    ] as const) {
      const error = caught(fn);
      expect(error, message).toBeInstanceOf(HoldrRefusal);
      expect(error.message).toBe(message);
    }
  });

  it('quotes no stored identifier when a read fails', () => {
    const account = card();
    importRows(account.id, [row()], { coverage: { start: '2026-09-01', end: '2026-09-30' } });
    const [stored] = repo.listCardTransactions();
    repo.internalGetDb().exec(`
      ALTER TABLE card_transactions RENAME TO card_transactions_kept;
      CREATE TABLE pan_${pan} (id TEXT);
      CREATE VIEW card_transactions AS SELECT * FROM pan_${pan};
      DROP TABLE pan_${pan};
    `);
    for (const [fn, operation] of [
      [() => repo.queryCardTransactions(), 'query card transactions'],
      [() => repo.listCardTransactionsMatching(), 'list matching card transactions'],
      [() => repo.getCardTransaction(stored.id), 'read card transaction'],
      // It reads the row first, so the failure carries that inner operation.
      [() => repo.listPossiblePostedCardVersions(stored.id), 'read card transaction'],
      [() => repo.listCardCategories(), 'list card categories'],
      [() => repo.listCardCoverage(), 'list card coverage'],
    ] as const) {
      expectValueFreeDbError(caught(fn), operation, 'SQLITE_ERROR');
    }
  });
});

describe('brokerage data', () => {
  it('is untouched by imports, edits, promotions and replacements', () => {
    repo.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 250, currency: 'USD' });
    repo.createTransaction({ id: 't1', accountId: 'fid', symbol: 'AAPL', date: '2026-05-04', quantity: 10, pricePerUnit: 150, currency: 'USD' });
    repo.insertCashEvent({
      accountId: 'fid', date: '2026-09-12', eventType: 'withdrawal', amount: -500, currency: 'USD', broker: 'fidelity',
      accountLast4: '2468', description: 'SYNTHETIC CARD PAYMENT TRANSFER', sourceFingerprint: 'c'.repeat(64),
    });
    repo.importCashHistory({
      accountId: 'fid', currency: 'USD', broker: 'fidelity', accountLast4: '2468', sourceHash: 'b'.repeat(64),
      method: 'test-v1', rows: [{ date: '2026-09-12', cashBalance: 250 }],
    });
    const before = brokerageSnapshot(repo);
    const account = card();
    importRows(account.id, [row({ externalIdHash: cardExternalIdHash('P'), status: 'pending', postedDate: null }), row({ status: 'pending', postedDate: null, amountMinor: 70 })]);
    importRows(account.id, [
      row({ externalIdHash: cardExternalIdHash('R') }),
      row({ amountMinor: 70 }),
      row({ kind: 'payment', amountMinor: -50000, description: 'AUTOPAY PAYMENT THANK YOU', transactionDate: '2026-09-13' }),
    ], { coverage: { start: '2026-09-01', end: '2026-09-30' } });
    const [first] = repo.listCardTransactions();
    repo.updateCardTransaction(first.id, { userCategory: 'Coffee', notes: 'synthetic' }, OWNER);
    // A dismissed pending row the owner says posted after all.
    const pendingP = repo.listCardTransactions().find((item) => item.externalIdHash === cardExternalIdHash('P'))!;
    repo.updateCardTransaction(pendingP.id, { status: 'removed' }, OWNER);
    importRows(account.id, [row({ externalIdHash: cardExternalIdHash('P'), postedDate: '2026-09-12' })], { promoteDismissedMatches: true });
    expect(repo.getCardTransaction(pendingP.id)?.status).toBe('posted');
    expect(brokerageSnapshot(repo)).toEqual(before);
  });
});
