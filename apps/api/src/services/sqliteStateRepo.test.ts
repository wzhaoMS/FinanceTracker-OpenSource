import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import util from 'node:util';
import Database from 'better-sqlite3';

import {
  CARD_TEXT_FORBIDDEN_RANGES, cardExternalIdHash, cardTransactionFingerprint, containsCardData, containsCardSecret,
} from '@finance-tracker/shared';
import { containsCardData as a075553ContainsCardData } from './__fixtures__/cardNumbers.a075553.js';
import { containsCardData as revision3ContainsCardData } from './__fixtures__/cardNumbers.06e694d.js';
import { CARD_GUARD_MESSAGES, CARD_SCHEMA, CARD_TABLES } from './cardGuards.js';
import { cardSyncActorRef } from './cardSyncDigests.js';
import { HoldrDbError, HoldrGuardRefusal, HoldrRefusal, isCardGuardRefusal, valueFreeDbCode } from './dbErrors.js';
import {
  CARD_GUARD_BUILD,
  CARD_REPO_OPERATIONS,
  SqliteStateRepo,
  rememberingCleanTexts,
  type CardGuardBuild,
  type CardImportInput,
  type CardImportRow,
} from './sqliteStateRepo.js';
import {
  CARD_V13_TABLES,
  CARD_V14_COLUMNS,
  CARD_V15_COLUMNS,
  downgradeCardSchema,
  withoutGuardChecks,
} from '../testing/cardSchemaDowngrade.js';

let dir: string;
let repo: SqliteStateRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-sqlite-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const fixture = {
  accounts: [
    { id: 'fid', name: 'Fidelity', type: 'Individual', cashBalance: 100, currency: 'USD' },
    { id: 'citi', name: 'Citi', cashBalance: 0, currency: 'USD' }, // no type
  ],
  transactions: [
    { id: 't1', accountId: 'fid', symbol: 'AAPL', date: '2026-05-04', quantity: 10,  pricePerUnit: 150, fees: 1, currency: 'USD', notes: 'first' },
    { id: 't2', accountId: 'fid', symbol: 'AAPL', date: '2026-05-05', quantity: -2,  pricePerUnit: 160,           currency: 'USD' },
    { id: 't3', accountId: 'citi', symbol: 'MSFT', date: '2026-05-04', quantity: 5,  pricePerUnit: 410,           currency: 'USD' },
  ],
};

describe('SqliteStateRepo', () => {
  it('reports empty before first write', () => {
    expect(repo.isEmpty()).toBe(true);
    expect(repo.read()).toBeNull();
  });

  it('round-trips the full state shape', () => {
    repo.write(fixture);
    expect(repo.read()).toEqual(fixture);
  });

  it('preserves array order across writes', () => {
    repo.write(fixture);
    const reversed = {
      accounts: [...fixture.accounts].reverse(),
      transactions: [...fixture.transactions].reverse(),
    };
    repo.write(reversed);
    expect(repo.read()).toEqual(reversed);
  });

  it('treats `write` as a full replace (no orphans)', () => {
    repo.write(fixture);
    const small = {
      accounts: [{ id: 'only', name: 'Only', cashBalance: 5, currency: 'USD' }],
      transactions: [],
    };
    repo.write(small);
    expect(repo.read()).toEqual(small);
  });

  it('refuses an invalid payload and leaves prior state intact', () => {
    repo.write(fixture);
    expect(() => repo.write({ accounts: 'no' } as never)).toThrow(/refusing to write/);
    expect(repo.read()).toEqual(fixture);
  });

  it('rejects a transaction whose accountId does not exist (validation, not FK)', () => {
    expect(() =>
      repo.write({
        accounts: [{ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' }],
        transactions: [
          { id: 't', accountId: 'GHOST', symbol: 'X', date: '2026-05-04', quantity: 1, pricePerUnit: 1, currency: 'USD' },
        ],
      }),
    ).toThrow(/does not match any account/);
  });

  it('rolls back on FK violation if validation is somehow bypassed', () => {
    repo.write(fixture);
    // Forge a row through the underlying db handle to prove FK enforcement.
    // Use `as unknown as` so we don't expose db on the public surface.
    const internal = repo as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
    expect(() => internal.db.prepare(
      'INSERT INTO transactions (id, account_id, symbol, date, quantity, price_per_unit, currency, sort_order) VALUES (?,?,?,?,?,?,?,?)',
    ).run('forged', 'GHOST', 'X', '2026-05-05', 1, 1, 'USD', 999)).toThrow(/FOREIGN KEY/);
    expect(repo.read()).toEqual(fixture);
  });

  it('persists across reopen', () => {
    repo.write(fixture);
    const file = path.join(dir, 'finance.db');
    repo.close();
    const repo2 = new SqliteStateRepo({ file });
    try {
      expect(repo2.read()).toEqual(fixture);
    } finally {
      repo2.close();
    }
  });

  it('stamps PRAGMA user_version on creation', () => {
    expect(repo.schemaVersion()).toBe(15);
  });

  it('records created_at / updated_at on inserts', () => {
    repo.write(fixture);
    // Reach into the db handle for a column-level assertion.
    const internal = repo as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
    const rows = internal.db
      .prepare('SELECT id, created_at, updated_at FROM accounts')
      .all() as Array<{ id: string; created_at: string; updated_at: string }>;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      // ISO 8601 with millisecond precision and trailing Z.
      expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(r.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('backfills timestamp columns on a legacy DB created before they existed', async () => {
    // Simulate an old DB by creating one without the new columns.
    const Database = (await import('better-sqlite3')).default;
    const file = path.join(dir, 'legacy.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
        cash_balance REAL NOT NULL, currency TEXT NOT NULL, sort_order INTEGER NOT NULL);
      CREATE TABLE transactions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        symbol TEXT NOT NULL, date TEXT NOT NULL, quantity REAL NOT NULL, price_per_unit REAL NOT NULL,
        fees REAL, currency TEXT NOT NULL, notes TEXT, sort_order INTEGER NOT NULL);
      INSERT INTO accounts VALUES ('a', 'A', 'Individual', 10, 'USD', 0);
    `);
    legacy.close();

    // Opening it with the current repo should add the columns and backfill.
    const upgraded = new SqliteStateRepo({ file });
    try {
      const internal = upgraded as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
      const cols = (internal.db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map((r) => r.name);
      expect(cols).toContain('created_at');
      expect(cols).toContain('updated_at');
      const rows = internal.db.prepare('SELECT created_at, updated_at FROM accounts').all() as Array<{
        created_at: string; updated_at: string;
      }>;
      expect(rows[0].created_at).toMatch(/^\d{4}-/);
      expect(rows[0].updated_at).toMatch(/^\d{4}-/);
      expect(upgraded.schemaVersion()).toBe(15);
    } finally {
      upgraded.close();
    }
  });

  it('upgrades a v9 DB without changing equity shape and round-trips options', async () => {
    const Database = (await import('better-sqlite3')).default;
    const file = path.join(dir, 'v9.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, cash_balance REAL NOT NULL,
        currency TEXT NOT NULL, sort_order INTEGER NOT NULL, account_number TEXT,
        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        symbol TEXT NOT NULL, date TEXT NOT NULL, quantity REAL NOT NULL,
        price_per_unit REAL NOT NULL, fees REAL, currency TEXT NOT NULL, notes TEXT,
        sort_order INTEGER NOT NULL, source_fingerprint TEXT,
        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO accounts
        (id, name, cash_balance, currency, sort_order, created_at, updated_at)
      VALUES ('a', 'A', 0, 'USD', 0, '2026-01-01', '2026-01-01');
      INSERT INTO transactions
        (id, account_id, symbol, date, quantity, price_per_unit, currency, sort_order, created_at, updated_at)
      VALUES ('equity', 'a', 'NBIS', '2026-07-01', 10, 200, 'USD', 0, '2026-01-01', '2026-01-01');
      PRAGMA user_version = 9;
    `);
    legacy.close();

    const upgraded = new SqliteStateRepo({ file });
    try {
      expect(upgraded.schemaVersion()).toBe(15);
      expect(upgraded.listCashHistory('a')).toEqual([]);
      expect(upgraded.listTransactions()).toEqual([{
        id: 'equity', accountId: 'a', symbol: 'NBIS', date: '2026-07-01',
        quantity: 10, pricePerUnit: 200, currency: 'USD',
      }]);
      const option = {
        id: 'option', accountId: 'a', symbol: 'NBIS260731P00165000', date: '2026-07-10',
        quantity: -5, pricePerUnit: 6.5632, fees: 3.4, currency: 'USD',
        instrumentType: 'option' as const, contractMultiplier: 100, positionEffect: 'open' as const,
      };
      upgraded.createTransaction(option);
      expect(upgraded.listTransactions().at(-1)).toEqual(option);
      expect(upgraded.findTransactionByFingerprint('a', null)).toBeNull();
    } finally {
      upgraded.close();
    }
  });

  it('legacy upgrade preserves the column DEFAULT so post-upgrade inserts get real timestamps', async () => {
    const Database = (await import('better-sqlite3')).default;
    const file = path.join(dir, 'legacy.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
        cash_balance REAL NOT NULL, currency TEXT NOT NULL, sort_order INTEGER NOT NULL);
      CREATE TABLE transactions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        symbol TEXT NOT NULL, date TEXT NOT NULL, quantity REAL NOT NULL, price_per_unit REAL NOT NULL,
        fees REAL, currency TEXT NOT NULL, notes TEXT, sort_order INTEGER NOT NULL);
      INSERT INTO accounts VALUES ('legacy-a', 'Legacy A', 'Individual', 10, 'USD', 0);
    `);
    legacy.close();

    const upgraded = new SqliteStateRepo({ file });
    try {
      // Insert a new account AFTER the upgrade.
      upgraded.createAccount({ id: 'new-b', name: 'New B', cashBalance: 0, currency: 'USD' });
      upgraded.createTransaction({
        id: 'new-t', accountId: 'new-b', symbol: 'AAPL', date: '2026-05-05',
        quantity: 1, pricePerUnit: 100, currency: 'USD',
      });

      const internal = upgraded as unknown as { db: { prepare(sql: string): { get(arg: unknown): unknown } } };
      const acct = internal.db
        .prepare('SELECT created_at, updated_at FROM accounts WHERE id = ?')
        .get('new-b') as { created_at: string; updated_at: string };
      const tx = internal.db
        .prepare('SELECT created_at, updated_at FROM transactions WHERE id = ?')
        .get('new-t') as { created_at: string; updated_at: string };

      // Reviewer-3 regression: BEFORE the rebuild fix, these were ''.
      expect(acct.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(acct.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(tx.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(tx.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      upgraded.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fine-grained CRUD methods (Phase 3)
// ---------------------------------------------------------------------------

describe('SqliteStateRepo CRUD', () => {
  it('records the snapshot interval invalidated by a late transaction', () => {
    repo.close();
    repo = new SqliteStateRepo({
      file: path.join(dir, 'late-import.db'),
      now: () => new Date('2026-05-06T15:30:00.000Z'),
    });
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 100, currency: 'USD' });
    const internal = repo as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown; all(): unknown[] } };
    };
    internal.db.prepare(
      `INSERT INTO account_snapshots
        (id, account_id, taken_at, market_value, cost_basis, cash_balance)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('s1', 'a', '2026-05-06T14:00:00.000Z', 1_000, 900, 100);

    repo.createTransaction({
      id: 'late', accountId: 'a', symbol: 'AAPL', date: '2026-05-05',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });

    expect(internal.db.prepare(
      `SELECT account_id, effective_date, detected_at, reason
         FROM account_history_invalidations`,
    ).all()).toEqual([{
      account_id: 'a',
      effective_date: '2026-05-05',
      detected_at: '2026-05-06T15:30:00.000Z',
      reason: 'transaction late was recorded after its effective date',
    }]);
  });

  it('invalidates history for financial edits and cash corrections, but not notes', () => {
    repo.close();
    repo = new SqliteStateRepo({
      file: path.join(dir, 'financial-correction.db'),
      now: () => new Date('2026-05-06T15:30:00.000Z'),
    });
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 100, currency: 'USD' });
    repo.createTransaction({
      id: 'known', accountId: 'a', symbol: 'AAPL', date: '2026-05-06',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    const internal = repo as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown; all(): unknown[] } };
    };
    internal.db.prepare(
      `INSERT INTO account_snapshots
        (id, account_id, taken_at, market_value, cost_basis, cash_balance)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('s1', 'a', '2026-05-06T14:00:00.000Z', 200, 200, 100);

    repo.updateTransaction('known', { notes: 'metadata only' });
    expect(internal.db.prepare('SELECT * FROM account_history_invalidations').all()).toHaveLength(0);

    repo.updateTransaction('known', { quantity: 2 });
    repo.updateAccount('a', { cashBalance: 50 });
    const reasons = internal.db.prepare(
      'SELECT effective_date, reason FROM account_history_invalidations ORDER BY id',
    ).all() as Array<{ effective_date: string; reason: string }>;
    expect(reasons).toEqual([
      { effective_date: '2026-05-06', reason: 'transaction known was corrected after snapshots were captured' },
      { effective_date: '2026-05-06', reason: 'cash balance was corrected after snapshots were captured' },
    ]);
  });

  it('creates, lists, gets, updates, and deletes accounts', () => {
    const a = repo.createAccount({ id: 'a', name: 'A', cashBalance: 100, currency: 'USD' });
    const b = repo.createAccount({ id: 'b', name: 'B', type: 'Roth', cashBalance: 0, currency: 'USD' });
    expect(repo.listAccounts().map((x) => x.id)).toEqual(['a', 'b']);
    expect(repo.getAccount('a')).toEqual(a);
    expect(repo.getAccount('missing')).toBeNull();

    const updated = repo.updateAccount('a', { name: 'A renamed', cashBalance: 250 });
    expect(updated).toEqual({ ...a, name: 'A renamed', cashBalance: 250 });
    expect(repo.getAccount('a')!.name).toBe('A renamed');

    expect(repo.deleteAccount('b').deleted).toBe(true);
    expect(repo.listAccounts().map((x) => x.id)).toEqual(['a']);
  });

  it('removes audit invalidations when an otherwise empty account is deleted', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    const internal = repo as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown; all(): unknown[] } };
    };
    internal.db.prepare(
      `INSERT INTO account_history_invalidations
        (account_id, effective_date, detected_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run('a', '2026-05-01', '2026-05-02T12:00:00Z', 'test');

    expect(repo.deleteAccount('a')).toEqual({ deleted: true });
    expect(internal.db.prepare('SELECT * FROM account_history_invalidations').all()).toEqual([]);
  });

  it('refuses to delete an account with transactions', () => {
    repo.createAccount({ id: 'acc', name: 'Acc', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't1', accountId: 'acc', symbol: 'AAPL', date: '2026-05-04',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    const res = repo.deleteAccount('acc');
    expect(res.deleted).toBe(false);
    expect(res.reason).toMatch(/1 transaction/);
    // Account still exists.
    expect(repo.getAccount('acc')).not.toBeNull();
  });

  it('rejects creating a transaction for a non-existent account', () => {
    expect(() =>
      repo.createTransaction({
        id: 't', accountId: 'nope', symbol: 'X', date: '2026-05-04',
        quantity: 1, pricePerUnit: 1, currency: 'USD',
      }),
    ).toThrow(/^account does not exist$/);
  });

  it('lists transactions globally and per-account', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createAccount({ id: 'b', name: 'B', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({ id: 't1', accountId: 'a', symbol: 'X', date: '2026-05-04', quantity: 1, pricePerUnit: 1, currency: 'USD' });
    repo.createTransaction({ id: 't2', accountId: 'b', symbol: 'Y', date: '2026-05-04', quantity: 2, pricePerUnit: 2, currency: 'USD' });
    expect(repo.listTransactions().map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(repo.listTransactions('a').map((t) => t.id)).toEqual(['t1']);
    expect(repo.listTransactions('missing')).toEqual([]);
  });

  it('deleteTransaction returns true/false based on row presence', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({ id: 't1', accountId: 'a', symbol: 'X', date: '2026-05-04', quantity: 1, pricePerUnit: 1, currency: 'USD' });
    expect(repo.deleteTransaction('t1')).toBe(true);
    expect(repo.deleteTransaction('t1')).toBe(false);
    expect(repo.listTransactions()).toEqual([]);
  });

  it('counts() reports DB size for /health', () => {
    expect(repo.counts()).toEqual({ accounts: 0, transactions: 0 });
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({ id: 't1', accountId: 'a', symbol: 'X', date: '2026-05-04', quantity: 1, pricePerUnit: 1, currency: 'USD' });
    repo.createTransaction({ id: 't2', accountId: 'a', symbol: 'Y', date: '2026-05-04', quantity: 1, pricePerUnit: 1, currency: 'USD' });
    expect(repo.counts()).toEqual({ accounts: 1, transactions: 2 });
  });
});

describe('SqliteStateRepo account NAV history', () => {
  const observation = {
    id: 'nav-1',
    accountId: 'schwab',
    broker: 'schwab',
    observedAt: '2025-04-30',
    nav: 12_345.67,
    currency: 'USD',
    statementPeriodStart: '2025-04-01',
    statementPeriodEnd: '2025-04-30',
    accountLast4: '2468',
    sourceDocumentHash: 'a'.repeat(64),
    sourceFileName: 'statement.pdf',
    sourcePage: 1,
  };

  beforeEach(() => {
    repo.createAccount({ id: 'schwab', name: 'Schwab', cashBalance: 0, currency: 'USD' });
  });

  it('stores and reads broker NAV with document provenance', () => {
    const result = repo.insertAccountNavObservation(observation);
    expect(result.inserted).toBe(true);
    expect(result.observation).toMatchObject(observation);
    expect(result.observation.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(repo.listAccountNavHistory('schwab')).toEqual([result.observation]);
  });

  it('is idempotent for the same account, observed date, and document hash', () => {
    expect(repo.insertAccountNavObservation(observation).inserted).toBe(true);
    const duplicate = repo.insertAccountNavObservation({ ...observation, id: 'nav-retry' });
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.observation.id).toBe('nav-1');
    expect(repo.listAccountNavHistory('schwab')).toHaveLength(1);
  });

  it('preserves conflicting source documents for later reconciliation', () => {
    repo.insertAccountNavObservation(observation);
    repo.insertAccountNavObservation({
      ...observation,
      id: 'nav-2',
      nav: 1_174,
      sourceDocumentHash: 'b'.repeat(64),
      sourceFileName: 'corrected-statement.pdf',
    });
    expect(repo.listAccountNavHistory('schwab')).toHaveLength(2);
  });

  it('filters observations by inclusive date bounds', () => {
    repo.insertAccountNavObservation(observation);
    repo.insertAccountNavObservation({
      ...observation,
      id: 'nav-2',
      observedAt: '2025-05-31',
      statementPeriodStart: '2025-05-01',
      statementPeriodEnd: '2025-05-31',
      sourceDocumentHash: 'b'.repeat(64),
    });
    expect(repo.listAccountNavHistory('schwab', '2025-05-01', '2025-06-01'))
      .toHaveLength(1);
  });

  it('rejects observations for an unknown account', () => {
    expect(() => repo.insertAccountNavObservation({ ...observation, accountId: 'missing' }))
      .toThrow(/^account does not exist$/);
  });

  it.each([
    ['non-finite NAV', { nav: Number.POSITIVE_INFINITY }, /nav/i],
    ['impossible observed date', { observedAt: '2025-02-30', statementPeriodEnd: '2025-02-30' }, /observedAt/i],
    ['period end mismatch', { statementPeriodEnd: '2025-04-29' }, /observedAt.*period end/i],
    ['reversed statement period', { statementPeriodStart: '2025-05-01' }, /period start/i],
    ['invalid account last four', { accountLast4: '57A9' }, /last4/i],
    ['invalid document hash', { sourceDocumentHash: 'abc' }, /document hash/i],
    ['invalid source page', { sourcePage: 0 }, /source page/i],
    ['invalid currency', { currency: 'usd' }, /currency/i],
    ['empty broker', { broker: '' }, /broker/i],
  ])('rejects malformed NAV provenance: %s', (_label, patch, expected) => {
    expect(() => repo.insertAccountNavObservation({ ...observation, ...patch }))
      .toThrow(expected);
  });
});

describe('SqliteStateRepo cash events', () => {
  const event = {
    accountId: 'fid',
    date: '2026-05-07',
    eventType: 'dividend' as const,
    amount: 12.34,
    currency: 'USD',
    broker: 'fidelity',
    accountLast4: '2468',
    description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
    sourceFingerprint: 'c'.repeat(64),
  };

  beforeEach(() => {
    repo.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 0, currency: 'USD' });
  });

  it('stores and reads a typed cash event with provenance', () => {
    const result = repo.insertCashEvent(event);
    expect(result.inserted).toBe(true);
    expect(result.event).toMatchObject(event);
    expect(result.event.id).toMatch(/^cash-/);
    expect(result.event.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(repo.listCashEvents('fid')).toEqual([result.event]);
  });

  it('is idempotent by account and source fingerprint', () => {
    const first = repo.insertCashEvent(event);
    const retry = repo.insertCashEvent({ ...event, description: 'changed client payload' });
    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(retry.event.id).toBe(first.event.id);
    expect(retry.event.description).toBe(event.description);
    expect(repo.listCashEvents('fid')).toHaveLength(1);
  });

  it('invalidates existing snapshots only once for an idempotent late cash event', () => {
    const internal = repo as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown; all(): unknown[] } };
    };
    internal.db.prepare(
      `INSERT INTO account_snapshots
        (id, account_id, taken_at, market_value, cost_basis, cash_balance)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('s1', 'fid', '2026-05-08T14:00:00.000Z', 100, 100, 0);

    expect(repo.insertCashEvent(event).inserted).toBe(true);
    expect(repo.insertCashEvent(event).inserted).toBe(false);

    const rows = internal.db.prepare(
      `SELECT account_id, effective_date, reason
         FROM account_history_invalidations`,
    ).all() as Array<{ account_id: string; effective_date: string; reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: 'fid', effective_date: '2026-05-07' });
    expect(rows[0].reason).toMatch(/^cash event cash-/);
  });

  it('does not backfill a phantom invalidation when an event predates all snapshots', () => {
    repo.insertCashEvent(event);
    const file = path.join(dir, 'finance.db');
    repo.close();
    repo = new SqliteStateRepo({ file });
    const internal = repo as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
    expect(internal.db.prepare('SELECT * FROM account_history_invalidations').all()).toEqual([]);
  });

  it('preserves same-day events with distinct occurrence fingerprints', () => {
    repo.insertCashEvent(event);
    repo.insertCashEvent({ ...event, sourceFingerprint: 'd'.repeat(64) });
    expect(repo.listCashEvents('fid')).toHaveLength(2);
  });

  it('finds by fingerprint and filters inclusive date ranges', () => {
    const first = repo.insertCashEvent(event).event;
    repo.insertCashEvent({
      ...event,
      date: '2026-06-01',
      eventType: 'transfer',
      amount: -50,
      sourceFingerprint: 'd'.repeat(64),
    });
    expect(repo.findCashEventByFingerprint('fid', event.sourceFingerprint)?.id).toBe(first.id);
    expect(repo.listCashEvents('fid', '2026-05-01', '2026-05-31')).toEqual([first]);
  });

  it('deletes by id and refuses account deletion while events remain', () => {
    const stored = repo.insertCashEvent(event).event;
    expect(repo.deleteAccount('fid')).toMatchObject({ deleted: false, reason: expect.stringMatching(/cash event/i) });
    expect(repo.deleteCashEvent(stored.id)).toBe(true);
    expect(repo.deleteCashEvent(stored.id)).toBe(false);
    expect(repo.deleteAccount('fid')).toEqual({ deleted: true });
  });

  it.each([
    ['unknown account', { accountId: 'missing' }, /^account does not exist$/],
    ['invalid date', { date: '2026-02-30' }, /date/i],
    ['invalid type', { eventType: 'bonus' }, /event type/i],
    ['zero amount', { amount: 0 }, /amount/i],
    ['non-finite amount', { amount: Number.POSITIVE_INFINITY }, /amount/i],
    ['negative deposit', { eventType: 'deposit', amount: -1 }, /deposit.*positive/i],
    ['positive withdrawal', { eventType: 'withdrawal', amount: 1 }, /withdrawal.*negative/i],
    ['invalid currency', { currency: 'usd' }, /currency/i],
    ['invalid broker', { broker: '' }, /broker/i],
    ['invalid last-four', { accountLast4: '24A8' }, /last4/i],
    ['empty description', { description: '' }, /description/i],
    ['invalid fingerprint', { sourceFingerprint: 'short' }, /fingerprint/i],
  ])('rejects malformed cash provenance: %s', (_label, patch, expected) => {
    expect(() => repo.insertCashEvent({ ...event, ...patch } as never)).toThrow(expected);
  });

  it('preserves a positive fee reversal instead of changing its category', () => {
    const reversal = repo.insertCashEvent({
      ...event,
      eventType: 'fee',
      amount: 5,
      sourceFingerprint: 'e'.repeat(64),
    }).event;
    expect(reversal).toMatchObject({ eventType: 'fee', amount: 5 });
  });
});

describe('SqliteStateRepo cash history (v12)', () => {
  const base = {
    accountId: 'fid',
    currency: 'USD',
    broker: 'fidelity',
    accountLast4: '2468',
    sourceHash: 'a'.repeat(64),
    method: 'fidelity-activity-eod-v1',
  };

  beforeEach(() => {
    repo.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 0, currency: 'USD' });
  });

  it('stores balances rounded to cents with provenance, ordered by date', () => {
    const result = repo.importCashHistory({
      ...base,
      rows: [
        { date: '2026-05-08', cashBalance: 120.004 },
        { date: '2026-05-07', cashBalance: 100 },
      ],
    });
    expect(result).toEqual({ inserted: 2, unchanged: 0, conflicts: [] });
    expect(repo.listCashHistory('fid')).toEqual([
      expect.objectContaining({ date: '2026-05-07', cashBalance: 100, sourceHash: base.sourceHash, method: base.method }),
      expect.objectContaining({ date: '2026-05-08', cashBalance: 120, broker: 'fidelity', accountLast4: '2468' }),
    ]);
  });

  it('treats an identical re-import as a no-op', () => {
    const rows = [{ date: '2026-05-07', cashBalance: 100 }];
    repo.importCashHistory({ ...base, rows });
    expect(repo.importCashHistory({ ...base, sourceHash: 'b'.repeat(64), rows })).toEqual({
      inserted: 0,
      unchanged: 1,
      conflicts: [],
    });
    expect(repo.listCashHistory('fid')[0].sourceHash).toBe(base.sourceHash);
  });

  it('rejects the whole import when any stored balance would change', () => {
    repo.importCashHistory({ ...base, rows: [{ date: '2026-05-07', cashBalance: 100 }] });
    const result = repo.importCashHistory({
      ...base,
      rows: [
        { date: '2026-05-06', cashBalance: 90 },
        { date: '2026-05-07', cashBalance: 101 },
      ],
    });
    expect(result).toEqual({
      inserted: 0,
      unchanged: 0,
      conflicts: [{ date: '2026-05-07', existing: 100, incoming: 101 }],
    });
    expect(repo.listCashHistory('fid').map((row) => row.date)).toEqual(['2026-05-07']);
  });

  it('refuses account deletion until the history is removed', () => {
    repo.importCashHistory({ ...base, rows: [{ date: '2026-05-07', cashBalance: 100 }] });
    expect(repo.deleteAccount('fid')).toMatchObject({ deleted: false, reason: expect.stringMatching(/cash history/i) });
    expect(repo.deleteCashHistory('fid')).toBe(1);
    expect(repo.deleteAccount('fid')).toEqual({ deleted: true });
  });

  it.each([
    ['unknown account', { accountId: 'missing' }, /^account does not exist$/],
    ['currency mismatch', { currency: 'EUR' }, /currency/i],
    ['invalid hash', { sourceHash: 'short' }, /source hash/i],
    ['invalid method', { method: 'Has Spaces' }, /method/i],
    ['empty rows', { rows: [] }, /between 1 and/i],
    ['invalid date', { rows: [{ date: '2026-02-30', cashBalance: 1 }] }, /dates/i],
    ['ancient date', { rows: [{ date: '1900-01-01', cashBalance: 1 }] }, /completed days from 1990-01-01/i],
    ['future date', { rows: [{ date: '2999-01-01', cashBalance: 1 }] }, /completed days from 1990-01-01/i],
    ['same-day date', {
      rows: [{
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date()),
        cashBalance: 1,
      }],
    }, /completed days from 1990-01-01/i],
    ['duplicate date', { rows: [{ date: '2026-05-07', cashBalance: 1 }, { date: '2026-05-07', cashBalance: 2 }] }, /duplicate/i],
    ['non-finite balance', { rows: [{ date: '2026-05-07', cashBalance: Number.NaN }] }, /finite/i],
  ])('rejects malformed cash history: %s', (_label, patch, expected) => {
    expect(() => repo.importCashHistory({
      ...base,
      rows: [{ date: '2026-05-07', cashBalance: 1 }],
      ...patch,
    } as never)).toThrow(expected);
  });
});

// ---------------------------------------------------------------------------
// v7: source_fingerprint dedup surface
// ---------------------------------------------------------------------------

describe('SqliteStateRepo source_fingerprint (v7)', () => {
  it('round-trips sourceFingerprint through createTransaction + listTransactions', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't1',
      accountId: 'a',
      symbol: 'AAPL',
      date: '2026-05-04',
      quantity: 1,
      pricePerUnit: 100,
      currency: 'USD',
      sourceFingerprint: 'fp-aapl-1',
    });
    // Round-trip via listTransactions.
    const [tx] = repo.listTransactions('a');
    expect(tx.sourceFingerprint).toBe('fp-aapl-1');
  });

  it('treats sourceFingerprint as optional (legacy/manual rows are NULL)', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't-manual',
      accountId: 'a',
      symbol: 'AAPL',
      date: '2026-05-04',
      quantity: 1,
      pricePerUnit: 100,
      currency: 'USD',
      // sourceFingerprint omitted on purpose.
    });
    const [tx] = repo.listTransactions('a');
    expect(tx.sourceFingerprint).toBeUndefined();
  });

  it('findTransactionByFingerprint returns the matching row', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't1',
      accountId: 'a',
      symbol: 'NBIS',
      date: '2026-05-04',
      quantity: 45.113,
      pricePerUnit: 177.82,
      currency: 'USD',
      sourceFingerprint: 'fp-nbis-buy-1',
    });
    const hit = repo.findTransactionByFingerprint('a', 'fp-nbis-buy-1');
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe('t1');
    expect(hit?.symbol).toBe('NBIS');
    expect(hit?.sourceFingerprint).toBe('fp-nbis-buy-1');
  });

  it('findTransactionByFingerprint scopes by account', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createAccount({ id: 'b', name: 'B', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't1',
      accountId: 'a',
      symbol: 'AAPL',
      date: '2026-05-04',
      quantity: 1,
      pricePerUnit: 100,
      currency: 'USD',
      sourceFingerprint: 'fp-shared',
    });
    expect(repo.findTransactionByFingerprint('a', 'fp-shared')?.id).toBe('t1');
    // Same fingerprint in a DIFFERENT account: no match. Activity rows are
    // dedup'd per-account so they can legitimately coexist across accounts.
    expect(repo.findTransactionByFingerprint('b', 'fp-shared')).toBeNull();
  });

  it('findTransactionByFingerprint returns null for nullish input (never matches absence)', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't1',
      accountId: 'a',
      symbol: 'AAPL',
      date: '2026-05-04',
      quantity: 1,
      pricePerUnit: 100,
      currency: 'USD',
      // No fingerprint: row exists with NULL.
    });
    expect(repo.findTransactionByFingerprint('a', null)).toBeNull();
    expect(repo.findTransactionByFingerprint('a', undefined)).toBeNull();
    expect(repo.findTransactionByFingerprint('a', '')).toBeNull();
  });

  it('rejects two rows with the same (accountId, sourceFingerprint) via the partial unique index', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't1',
      accountId: 'a',
      symbol: 'AAPL',
      date: '2026-05-04',
      quantity: 1,
      pricePerUnit: 100,
      currency: 'USD',
      sourceFingerprint: 'fp-x',
    });
    // Second insert with the same fingerprint must throw — the unique
    // index is the safety net behind the application-level dedup check.
    expect(() =>
      repo.createTransaction({
        id: 't2',
        accountId: 'a',
        symbol: 'AAPL',
        date: '2026-05-04',
        quantity: 1,
        pricePerUnit: 100,
        currency: 'USD',
        sourceFingerprint: 'fp-x',
      }),
    ).toThrow();
  });

  it('allows multiple rows with NULL sourceFingerprint (partial index excludes them)', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    // Two manual entries, neither has a fingerprint. Must not collide.
    repo.createTransaction({
      id: 't1', accountId: 'a', symbol: 'AAPL', date: '2026-05-04',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    repo.createTransaction({
      id: 't2', accountId: 'a', symbol: 'AAPL', date: '2026-05-04',
      quantity: 2, pricePerUnit: 99, currency: 'USD',
    });
    expect(repo.listTransactions('a')).toHaveLength(2);
  });

  it('allows the same fingerprint across DIFFERENT accounts', () => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
    repo.createAccount({ id: 'b', name: 'B', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 't-a', accountId: 'a', symbol: 'AAPL', date: '2026-05-04',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
      sourceFingerprint: 'fp-shared',
    });
    // Cross-account is allowed: the unique index includes account_id.
    expect(() =>
      repo.createTransaction({
        id: 't-b', accountId: 'b', symbol: 'AAPL', date: '2026-05-04',
        quantity: 1, pricePerUnit: 100, currency: 'USD',
        sourceFingerprint: 'fp-shared',
      }),
    ).not.toThrow();
  });
});

describe('SqliteStateRepo legacy-snapshot eviction (double-count fix)', () => {
  beforeEach(() => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
  });

  it('deletes legacy imported snapshot rows for (account, symbol) when an activity row is created', () => {
    // Legacy snapshot from importMapper: NULL fingerprint, notes='imported'.
    repo.createTransaction({
      id: 'snap', accountId: 'a', symbol: 'NBIS', date: '2026-05-07',
      quantity: 199.806, pricePerUnit: 175.17, currency: 'USD', notes: 'imported',
    });
    expect(repo.listTransactions('a')).toHaveLength(1);

    // Activity commit (sha256 fp).
    repo.createTransaction({
      id: 'act', accountId: 'a', symbol: 'NBIS', date: '2026-04-15',
      quantity: 199.806, pricePerUnit: 170, currency: 'USD',
      notes: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
      sourceFingerprint: 'deadbeefcafef00d',
    });

    const rows = repo.listTransactions('a');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('act');
  });

  it('also evicts screenshot-imported rows whose notes start with "imported "', () => {
    repo.createTransaction({
      id: 'snap', accountId: 'a', symbol: 'TSLA', date: '2026-05-07',
      quantity: 45, pricePerUnit: 250, currency: 'USD',
      notes: 'imported from Citi screenshot 2026-05-04',
    });
    repo.createTransaction({
      id: 'act', accountId: 'a', symbol: 'TSLA', date: '2026-04-09',
      quantity: -20, pricePerUnit: 260, currency: 'USD',
      notes: 'YOU SOLD TESLA INC COM (TSLA) (Cash)',
      sourceFingerprint: 'beadface11223344',
    });
    const rows = repo.listTransactions('a');
    expect(rows.map((r) => r.id)).toEqual(['act']);
  });

  it('does not evict legacy rows for a different (account, symbol)', () => {
    // Same symbol, different account.
    repo.createAccount({ id: 'b', name: 'B', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 'snap-a', accountId: 'a', symbol: 'NBIS', date: '2026-05-07',
      quantity: 200, pricePerUnit: 175, currency: 'USD', notes: 'imported',
    });
    repo.createTransaction({
      id: 'act-b', accountId: 'b', symbol: 'NBIS', date: '2026-04-15',
      quantity: 100, pricePerUnit: 170, currency: 'USD',
      notes: 'YOU BOUGHT NBIS', sourceFingerprint: 'aaaabbbbccccdddd',
    });
    expect(repo.listTransactions('a').map((r) => r.id)).toEqual(['snap-a']);
    expect(repo.listTransactions('b').map((r) => r.id)).toEqual(['act-b']);
  });

  it('does NOT evict hand-entered rows (notes do not start with "imported")', () => {
    repo.createTransaction({
      id: 'manual', accountId: 'a', symbol: 'AAPL', date: '2026-01-01',
      quantity: 10, pricePerUnit: 150, currency: 'USD',
      notes: 'bought via brokerage in person',
    });
    repo.createTransaction({
      id: 'act', accountId: 'a', symbol: 'AAPL', date: '2026-03-01',
      quantity: 5, pricePerUnit: 170, currency: 'USD',
      notes: 'YOU BOUGHT APPLE INC (AAPL) (Cash)',
      sourceFingerprint: '1234deadbeef5678',
    });
    expect(repo.listTransactions('a')).toHaveLength(2);
  });

  it('does NOT evict on `pos:`-fingerprint inserts (those are snapshot rows themselves)', () => {
    repo.createTransaction({
      id: 'snap', accountId: 'a', symbol: 'MSFT', date: '2026-05-07',
      quantity: 3, pricePerUnit: 405, currency: 'USD', notes: 'imported',
    });
    repo.createTransaction({
      id: 'pos', accountId: 'a', symbol: 'MSFT', date: '2026-05-07',
      quantity: 3, pricePerUnit: 405, currency: 'USD',
      sourceFingerprint: 'pos:MSFT',
    });
    // Both survive. (Cleanup of legacy rows for `pos:` inserts is the
    // domain of replaceSnapshotPositions, not createTransaction — keeping
    // this hook narrow avoids deleting hand-curated history during a
    // routine snapshot import.)
    expect(repo.listTransactions('a')).toHaveLength(2);
  });
});

describe('SqliteStateRepo replaceSnapshotPositions (idempotency + legacy eviction)', () => {
  beforeEach(() => {
    repo.createAccount({ id: 'a', name: 'A', cashBalance: 0, currency: 'USD' });
  });

  /** Build a `pos:<sym>` snapshot transaction. */
  function snapTx(id: string, symbol: string, qty: number, price: number) {
    return {
      id,
      accountId: 'a',
      symbol,
      date: '2026-05-07',
      quantity: qty,
      pricePerUnit: price,
      currency: 'USD',
      notes: 'imported',
      sourceFingerprint: `pos:${symbol}`,
    };
  }

  it('re-pulling positions twice yields exactly one row per (account, symbol) - no duplicates', () => {
    repo.replaceSnapshotPositions('a', [
      snapTx('p1', 'MSFT', 100, 410),
      snapTx('p2', 'NBIS', 200, 175),
      snapTx('p3', 'TSLA', 45, 395),
    ]);
    // Second pull (different ids, same symbols, slightly drifted prices -
    // exactly what the broker bridge does on a re-pull).
    const r = repo.replaceSnapshotPositions('a', [
      snapTx('q1', 'MSFT', 100, 414),
      snapTx('q2', 'NBIS', 200, 195),
      snapTx('q3', 'TSLA', 45, 399),
    ]);
    expect(r.deleted).toBe(3);
    expect(r.inserted).toBe(3);

    const rows = repo.listTransactions('a');
    expect(rows).toHaveLength(3);
    const grouped = new Map<string, number>();
    for (const t of rows) {
      const k = `${t.accountId}\u0000${t.symbol}`;
      grouped.set(k, (grouped.get(k) ?? 0) + 1);
    }
    for (const [k, c] of grouped) expect(c, `group ${k}`).toBe(1);
    expect(rows.find((t) => t.symbol === 'MSFT')!.id).toBe('q1');
  });

  it('evicts legacy NULL-fingerprint rows whose notes start with "imported" (the actual Citi bug)', () => {
    repo.createTransaction({
      id: 'legacy', accountId: 'a', symbol: 'MSFT', date: '2026-05-04',
      quantity: 100, pricePerUnit: 414.44, currency: 'USD',
      notes: 'imported from broker screenshot 2026-05-04',
    });
    const r = repo.replaceSnapshotPositions('a', [snapTx('p1', 'MSFT', 100, 413.96)]);
    expect(r.deleted).toBe(1);
    expect(r.inserted).toBe(1);
    expect(repo.listTransactions('a').map((t) => t.id)).toEqual(['p1']);
  });

  it('evicts BOTH legacy and modern snapshot rows for the account in one pass', () => {
    repo.createTransaction({
      id: 'legacy', accountId: 'a', symbol: 'NBIS', date: '2026-05-04',
      quantity: 200, pricePerUnit: 154.49, currency: 'USD',
      notes: 'imported from Citi screenshot 2026-05-04',
    });
    repo.createTransaction({
      id: 'modern-old', accountId: 'a', symbol: 'NBIS', date: '2026-05-07',
      quantity: 200, pricePerUnit: 195.09, currency: 'USD',
      notes: 'imported', sourceFingerprint: 'pos:NBIS',
    });
    expect(repo.listTransactions('a')).toHaveLength(2);
    const r = repo.replaceSnapshotPositions('a', [snapTx('p1', 'NBIS', 200, 196.0)]);
    expect(r.deleted).toBe(2);
    expect(r.inserted).toBe(1);
    expect(repo.listTransactions('a').map((t) => t.id)).toEqual(['p1']);
  });

  it('preserves activity rows (sha256 fingerprint) and hand-entered rows (no "imported" prefix)', () => {
    repo.createTransaction({
      id: 'activity', accountId: 'a', symbol: 'MSFT', date: '2026-04-01',
      quantity: 50, pricePerUnit: 400, currency: 'USD',
      notes: 'YOU BOUGHT MICROSOFT CORP (MSFT) (Cash)',
      sourceFingerprint: 'deadbeef0123456789abcdef',
    });
    repo.createTransaction({
      id: 'manual', accountId: 'a', symbol: 'AAPL', date: '2026-03-01',
      quantity: 10, pricePerUnit: 150, currency: 'USD',
      notes: 'bought in person at brokerage',
    });
    repo.createTransaction({
      id: 'legacy', accountId: 'a', symbol: 'TSLA', date: '2026-05-04',
      quantity: 45, pricePerUnit: 390, currency: 'USD',
      notes: 'imported from broker screenshot 2026-05-04',
    });
    const r = repo.replaceSnapshotPositions('a', [
      snapTx('p1', 'MSFT', 100, 414),
      snapTx('p2', 'TSLA', 45, 399),
    ]);
    expect(r.deleted).toBe(1);
    expect(r.inserted).toBe(2);
    const ids = new Set(repo.listTransactions('a').map((t) => t.id));
    expect(ids).toEqual(new Set(['activity', 'manual', 'p1', 'p2']));
  });

  it('only touches the target account - other accounts are untouched', () => {
    repo.createAccount({ id: 'b', name: 'B', cashBalance: 0, currency: 'USD' });
    repo.createTransaction({
      id: 'b-legacy', accountId: 'b', symbol: 'MSFT', date: '2026-05-04',
      quantity: 100, pricePerUnit: 414, currency: 'USD',
      notes: 'imported from broker screenshot 2026-05-04',
    });
    repo.createTransaction({
      id: 'b-modern', accountId: 'b', symbol: 'MSFT', date: '2026-05-07',
      quantity: 100, pricePerUnit: 414, currency: 'USD',
      notes: 'imported', sourceFingerprint: 'pos:MSFT',
    });
    repo.replaceSnapshotPositions('a', [snapTx('p1', 'MSFT', 100, 414)]);
    expect(repo.listTransactions('b').map((t) => t.id).sort()).toEqual(['b-legacy', 'b-modern']);
  });
});

// ---------------------------------------------------------------------------
// v13: card spending. Every fixture is synthetic; the card numbers are the
// networks' published test numbers.
// ---------------------------------------------------------------------------

const TEST_CARD_NUMBERS = ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117'];
const PAN = TEST_CARD_NUMBERS[0];
/** The test PAN written with the digits of the script whose zero is `zero`. */
const panInScript = (zero: number) => PAN.replace(/\d/g, (digit) => String.fromCodePoint(zero + Number(digit)));
const ARABIC_INDIC_PAN = panInScript(0x0660);
const GUARD_REVISION = CARD_GUARD_BUILD.revision;
const NEWER_REVISION = GUARD_REVISION + 1;
const revisionLine = (revision: number) => `\n-- holdr card guard revision ${revision}\n`;
/** The second comment line of every guard this build installs. */
const ROWS_CHECKED_LINE = '-- installed only after every stored row passed these checks';
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** The refusal when stored card rows fail this build's guards: the failures listed, then how many more. */
const storedRowsRefusal = (listed: string[], more = 0) =>
  `stored card rows fail this build's card guards (revision ${GUARD_REVISION}): ${listed.join(', ')}` +
  `${more ? `, and ${more} more` : ''}. Refusing to open the database; nothing was changed. ` +
  'Restore a backup made before those rows were written, or fix or delete them with the build that wrote them, ' +
  'then open the database with this build again.';
const AMEX_REFERENCE = cardExternalIdHash('320252940123456789');
const COFFEE_FINGERPRINT = cardTransactionFingerprint(
  { transactionDate: '2026-10-01', amountMinor: 1250, description: 'BLUE BOTTLE COFFEE' },
  0,
);

type RawDb = ReturnType<SqliteStateRepo['internalGetDb']>;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

const rawDb = (r: SqliteStateRepo): RawDb => r.internalGetDb();

function cardRow(patch: Partial<CardImportRow> = {}): CardImportRow {
  return {
    transactionDate: '2026-10-01',
    postedDate: '2026-10-02',
    status: 'posted',
    amountMinor: 1250,
    currency: 'USD',
    kind: 'purchase',
    description: 'BLUE BOTTLE COFFEE',
    merchant: 'Blue Bottle',
    issuerCategory: 'Restaurant-Coffee',
    ...patch,
  };
}

function cardImport(cardAccountId: string, rows: CardImportRow[], patch: Partial<CardImportInput> = {}): CardImportInput {
  return { cardAccountId, source: 'amex-csv', parserVersion: 'amex-csv@1', rows, ...patch };
}

function schemaObjects(db: RawDb): SchemaObject[] {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as SchemaObject[];
}

const isCardObject = (object: SchemaObject) => object.tbl_name.startsWith('card_') || object.name.includes('card_');

/** Every row of every table the filter accepts, keyed by table. */
function dumpTables(db: RawDb, include: (table: string) => boolean): Record<string, unknown[]> {
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((table) => table.name).filter(include);
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
}

function insertRow(db: RawDb, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

/** A database file's bytes, and which of its journal files exist. */
function fileState(file: string) {
  return {
    sha256: sha256(readFileSync(file)),
    sidecars: ['-wal', '-shm', '-journal'].filter((suffix) => existsSync(`${file}${suffix}`)),
  };
}

/** A message carries no stored value: none of the planted ones, and nothing either detector flags. */
function expectValueFree(message: string, planted: readonly string[] = []): void {
  for (const value of planted) expect(message, `message holds ${JSON.stringify(value)}`).not.toContain(value);
  expect(containsCardData(message), message).toBe(false);
  expect(containsCardSecret(message), message).toBe(false);
}

/**
 * This build refuses to open `file` with exactly `message`, closes its
 * handle, and leaves every byte of the database as it was. The message must
 * be value-free, `planted` naming what the test stored.
 */
function expectRefusedByteIdentical(file: string, message: string, planted: readonly string[] = []): Error {
  const before = fileState(file);
  const close = vi.spyOn(Database.prototype, 'close');
  let error: unknown;
  try {
    new SqliteStateRepo({ file }).close();
  } catch (caught) {
    error = caught;
  }
  const closes = close.mock.calls.length;
  close.mockRestore();
  expect((error as Error | undefined)?.message).toBe(message);
  expect(closes).toBe(1);
  expect(fileState(file)).toEqual(before);
  expectValueFree(message, planted);
  return error as Error;
}

function seedBrokerage(r: SqliteStateRepo): void {
  r.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 250, currency: 'USD', accountNumber: 'X2468' });
  r.createTransaction({
    id: 't1', accountId: 'fid', symbol: 'AAPL', date: '2026-05-04', quantity: 10, pricePerUnit: 150,
    currency: 'USD', sourceFingerprint: 'a'.repeat(64),
  });
  r.createTransaction({
    id: 'opt', accountId: 'fid', symbol: 'NBIS260731P00165000', date: '2026-07-10', quantity: -5,
    pricePerUnit: 6.5, currency: 'USD', instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
  });
  r.insertCashEvent({
    accountId: 'fid', date: '2026-05-07', eventType: 'dividend', amount: 12.34, currency: 'USD',
    broker: 'fidelity', accountLast4: '2468', description: 'DIVIDEND RECEIVED SYNTHETIC FUND',
    sourceFingerprint: 'c'.repeat(64),
  });
  r.importCashHistory({
    accountId: 'fid', currency: 'USD', broker: 'fidelity', accountLast4: '2468', sourceHash: 'b'.repeat(64),
    method: 'fidelity-activity-eod-v1', rows: [{ date: '2026-05-07', cashBalance: 262.34 }],
  });
  const db = r.internalGetDb();
  db.prepare(
    `INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('s1', 'fid', '2026-05-06T14:00:00.000Z', 1_500, 1_500, 250);
  db.prepare(
    `INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason)
     VALUES (?, ?, ?, ?)`,
  ).run('fid', '2026-05-01', '2026-05-02T12:00:00.000Z', 'synthetic audit row');
  db.prepare('INSERT INTO manual_prices (symbol, date, close) VALUES (?, ?, ?)').run('VANG500', '2026-05-01', 101.5);
}

/**
 * A database as the v12 build left it. v13, v14 and v15 only add the card
 * tables (their indexes and triggers drop with them) and leave SCHEMA_SQL
 * unchanged, so this matches a file written by the v12 code object for object.
 */
function createV12Database(file: string, seed: (r: SqliteStateRepo) => void = () => {}): void {
  const current = new SqliteStateRepo({ file });
  seed(current);
  current.close();
  const db = new Database(file);
  for (const table of [...CARD_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.pragma('user_version = 12');
  db.close();
}

/** The guard triggers on card tables: two per table, named trg_<table>_guard_insert/update. */
const GUARD_TRIGGERS = "type = 'trigger' AND (name LIKE 'trg_card%_guard_insert' OR name LIKE 'trg_card%_guard_update')";

describe('SqliteStateRepo card spending schema (v13)', () => {
  it('creates the card tables, indexes and guards on a fresh database', () => {
    expect(repo.schemaVersion()).toBe(15);
    const db = rawDb(repo);
    const objects = schemaObjects(db).filter((o) => isCardObject(o) && !o.name.startsWith('sqlite_'));
    expect(objects.filter((o) => o.type === 'table').map((o) => o.name).sort()).toEqual([...CARD_TABLES].sort());
    const names = objects.map((o) => `${o.type}:${o.name}`);
    // v13's indexes stay; card_transactions, rebuilt by v15, gets its two back.
    expect(names).toEqual(expect.arrayContaining([
      'index:idx_card_accounts_identity',
      'index:idx_card_import_batches_account',
      'index:idx_card_transactions_account_date',
      'index:idx_card_transactions_batch',
    ]));
    // v13's unique dedupe keys are gone: a key's identity is its source identity tuple (v15).
    expect(names).not.toContain('index:idx_card_transactions_external_id');
    expect(names).not.toContain('index:idx_card_transactions_fingerprint');
    // Two guards per card table, and v15's invariant triggers.
    const triggers = objects.filter((o) => o.type === 'trigger').map((o) => o.name);
    expect(triggers.filter((name) => /^trg_\w+_guard_(insert|update)$/.test(name)).sort())
      .toEqual(CARD_TABLES.flatMap((table) => [`trg_${table}_guard_insert`, `trg_${table}_guard_update`]).sort());
    expect(triggers.filter((name) => /^trg_\w+_inv_\w+$/.test(name))).toHaveLength(113);
    expect(triggers).toHaveLength(2 * CARD_TABLES.length + 113);
    const identity = (db.prepare('PRAGMA index_list(card_accounts)').all() as Array<{ name: string; unique: number }>)
      .find((index) => index.name === 'idx_card_accounts_identity');
    expect(identity?.unique).toBe(0);
    expect((db.prepare('PRAGMA index_info(idx_card_accounts_identity)').all() as Array<{ name: string }>).map((c) => c.name))
      .toEqual(['issuer', 'owner', 'last4']);
    for (const table of CARD_TABLES) {
      const targets = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).map((fk) => fk.table);
      expect(targets.every((target) => target.startsWith('card_')), `${table} references only card tables`).toBe(true);
    }
    expect(repo.listCardAccounts()).toEqual([]);
    expect(repo.listCardTransactions()).toEqual([]);
  });

  it('upgrades a v12 database without touching its data or schema', () => {
    const file = path.join(dir, 'v12.db');
    createV12Database(file, seedBrokerage);
    const v12 = new Database(file);
    const before = { rows: dumpTables(v12, () => true), schema: schemaObjects(v12) };
    expect(v12.pragma('user_version', { simple: true })).toBe(12);
    expect(before.schema.filter(isCardObject)).toEqual([]);
    v12.close();

    const upgraded = new SqliteStateRepo({ file });
    try {
      const db = rawDb(upgraded);
      expect(upgraded.schemaVersion()).toBe(15);
      expect(dumpTables(db, (table) => !table.startsWith('card_'))).toEqual(before.rows);
      expect(schemaObjects(db).filter((o) => !isCardObject(o))).toEqual(before.schema);
      // No card data, only what v15 seeds: its registries, the policy, the
      // four disabled issuers and the migration's audit row.
      const cardRows = dumpTables(db, (table) => table.startsWith('card_'));
      expect(Object.keys(cardRows).sort()).toEqual([...CARD_TABLES].sort());
      expect(Object.fromEntries(Object.entries(cardRows).filter(([, rows]) => rows.length > 0).map(([t, rows]) => [t, rows.length])))
        .toEqual({ card_sync_sources: 5, card_sync_namespaces: 12, card_sync_policy: 1, card_sync_issuer_policy: 4, card_sync_audit_events: 1 });
      expect(before.rows.transactions).toHaveLength(2);
      expect(before.rows.account_cash_history).toHaveLength(1);

      const card = upgraded.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD' });
      expect(upgraded.importCardTransactions(cardImport(card.id, [cardRow()])).newCount).toBe(1);
      expect(() => db.prepare('UPDATE card_transactions SET notes = ?').run('SYNTHETIC 4111111111111111'))
        .toThrow(/card_transactions\.notes must not contain/);
    } finally {
      upgraded.close();
    }
  });

  it('reopens a v13 database without rewriting its schema or data', () => {
    const file = path.join(dir, 'finance.db');
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' });
    repo.importCardTransactions(cardImport(card.id, [cardRow(), cardRow()]));
    const db = rawDb(repo);
    const before = {
      cookie: db.pragma('schema_version', { simple: true }),
      schema: schemaObjects(db),
      rows: dumpTables(db, () => true),
    };
    repo.close();

    for (let open = 0; open < 2; open += 1) {
      repo = new SqliteStateRepo({ file });
      const again = rawDb(repo);
      expect(repo.schemaVersion()).toBe(15);
      expect(again.pragma('schema_version', { simple: true })).toBe(before.cookie);
      expect(schemaObjects(again)).toEqual(before.schema);
      expect(dumpTables(again, () => true)).toEqual(before.rows);
      repo.close();
    }
    repo = new SqliteStateRepo({ file });
    expect(repo.importCardTransactions(cardImport(card.id, [cardRow(), cardRow()])))
      .toMatchObject({ rowCount: 2, newCount: 0, duplicateCount: 2 });
  });

  it.each([
    [
      'a stray card_import_batches table',
      "CREATE TABLE card_import_batches (id TEXT PRIMARY KEY); INSERT INTO card_import_batches VALUES ('stray');",
    ],
    [
      'an object named like the last card index, after the card tables were created',
      'CREATE INDEX idx_card_transactions_batch ON accounts(name);',
    ],
  ])('rolls back a failed v12 upgrade with %s and closes the handle', (_label, sabotage) => {
    const file = path.join(dir, 'v12.db');
    createV12Database(file, seedBrokerage);
    const setup = new Database(file);
    setup.exec(sabotage);
    const before = { rows: dumpTables(setup, () => true), schema: schemaObjects(setup) };
    setup.close();

    // SQLite's "... already exists" names a stored object, so only the
    // operation and the result code leave the constructor.
    const close = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => new SqliteStateRepo({ file })).toThrow(
        expect.objectContaining({ name: 'HoldrDbError', message: 'open database failed (SQLITE_ERROR)', code: 'SQLITE_ERROR' }),
      );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }

    const after = new Database(file);
    try {
      expect(after.pragma('user_version', { simple: true })).toBe(12);
      expect(schemaObjects(after)).toEqual(before.schema);
      expect(dumpTables(after, () => true)).toEqual(before.rows);
    } finally {
      after.close();
    }
  });

  it('accepts last4 only as exactly four ASCII digits, never padded, on INSERT and UPDATE', () => {
    const db = rawDb(repo);
    const insert = db.prepare(
      "INSERT INTO card_accounts (id, issuer, owner, last4, currency) VALUES (?, 'amex', 'alex', ?, 'USD')",
    );
    insert.run('card-acct-none', null);
    insert.run('card-acct-zeros', '0042');
    const update = db.prepare('UPDATE card_accounts SET last4 = ? WHERE id = ?');
    const invalid: Array<[unknown, RegExp]> = [
      ...['', '123', '12345', '90003', '12a4', 'abcd', ' 123', '123 '].map(
        (last4): [unknown, RegExp] => [last4, /^CHECK constraint failed: last4/],
      ),
      [`0042\0${PAN}`, /^card_accounts\.last4 must not contain NUL characters$/],
      [Buffer.from('0042'), /^card_accounts\.last4 must be stored as text$/],
      ['١٢٣٤', /^card_accounts\.last4 must not contain non-ASCII digits or invisible characters$/],
      ['１２３４', /^card_accounts\.last4 must not contain non-ASCII digits or invisible characters$/],
    ];
    for (const [last4, expected] of invalid) {
      expect(() => insert.run('card-acct-bad', last4), JSON.stringify(last4)).toThrow(expected);
      expect(() => update.run(last4, 'card-acct-zeros'), JSON.stringify(last4)).toThrow(expected);
    }
    // The CHECK alone is whole-value too: without the guard triggers it still
    // sees past an embedded NUL and refuses BLOBs and other scripts.
    db.exec('DROP TRIGGER trg_card_accounts_guard_insert; DROP TRIGGER trg_card_accounts_guard_update;');
    for (const last4 of [`0042\0${PAN}`, Buffer.from('0042'), '١٢٣٤']) {
      expect(() => insert.run('card-acct-bad', last4), JSON.stringify(last4)).toThrow(/^CHECK constraint failed: last4/);
      expect(() => update.run(last4, 'card-acct-zeros'), JSON.stringify(last4)).toThrow(/^CHECK constraint failed: last4/);
    }
    expect(db.prepare('SELECT id, last4, length(CAST(last4 AS BLOB)) AS bytes FROM card_accounts ORDER BY rowid').all())
      .toEqual([{ id: 'card-acct-none', last4: null, bytes: null }, { id: 'card-acct-zeros', last4: '0042', bytes: 4 }]);

    for (const last4 of ['', '123', '90003', '12 34', '١٢٣٤', `0042\0${PAN}`]) {
      expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4, currency: 'USD' }))
        .toThrow(/^last4 must be exactly four digits$/);
    }
    expect(repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0042', currency: 'USD' }).last4).toBe('0042');
  });

  it('allows last-4 collisions, keeping each card account and its rows apart', () => {
    const primary = repo.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Gold', last4: '0003', currency: 'USD' });
    const other = repo.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Gold (old)', last4: '0003', currency: 'USD' });
    expect(primary.id).not.toBe(other.id);
    expect(repo.listCardAccounts().map((card) => card.id)).toEqual([primary.id, other.id]);
    expect(repo.importCardTransactions(cardImport(primary.id, [cardRow({ externalIdHash: AMEX_REFERENCE }), cardRow()])).newCount).toBe(2);
    expect(repo.importCardTransactions(cardImport(other.id, [cardRow({ externalIdHash: AMEX_REFERENCE }), cardRow()])).newCount).toBe(2);
    expect(repo.listCardTransactions({ cardAccountId: primary.id })).toHaveLength(2);
    expect(repo.listCardTransactions({ cardAccountId: other.id })).toHaveLength(2);
  });

  it('leaves brokerage cash, cash history, holdings and history untouched', () => {
    seedBrokerage(repo);
    const db = rawDb(repo);
    const snapshot = () => ({
      state: repo.read(),
      counts: repo.counts(),
      cashEvents: repo.listAllCashEvents(),
      cashHistory: repo.listCashHistory('fid'),
      ledger: dumpTables(db, (table) => !table.startsWith('card_')),
    });
    const before = snapshot();
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' });
    repo.importCardTransactions(cardImport(card.id, [
      cardRow(),
      cardRow({ kind: 'refund', amountMinor: -1250 }),
      cardRow({ kind: 'payment', amountMinor: -50_000, description: 'ONLINE PAYMENT - THANK YOU', merchant: null }),
      cardRow({ kind: 'interest', amountMinor: 1_999, description: 'INTEREST CHARGE ON PURCHASES' }),
    ]));
    expect(repo.listCardTransactions()).toHaveLength(4);
    expect(snapshot()).toEqual(before);
  });
});

describe('SqliteStateRepo card guards (v13)', () => {
  const at = '2026-10-16T12:00:00.000Z';
  const ORDER = ['card_accounts', 'card_import_batches', 'card_transactions'] as const;
  /** The fixture account's legacy card scope, as createCardAccount and the v15 migration create it. */
  const LEGACY_SCOPE = {
    id: `scp_${'g'.repeat(32)}`, card_account_id: 'card-acct-guard', kind: 'legacy', holder_alias: 'unknown', last4: null,
    label: 'File imports (card not recorded)', status: 'active', version: 1, confirmed_by_ref: null, confirmed_at: null,
    retired_at: null, created_at: at, updated_at: at,
  };
  const VALID: Record<(typeof ORDER)[number], Record<string, unknown>> = {
    card_accounts: {
      id: 'card-acct-guard', issuer: 'amex', owner: 'alex', nickname: 'Blue Cash', last4: '0003', last5: '90003',
      currency: 'USD', status: 'active', created_at: at, updated_at: at, ledger_revision: 0,
    },
    card_import_batches: {
      id: 'card-import-guard', card_account_id: 'card-acct-guard', source: 'amex-csv', parser_version: 'amex-csv@1',
      row_count: 3, new_count: 1, duplicate_count: 1, rejected_count: 1, imported_at: at,
      coverage_start: '2026-09-01', coverage_end: '2026-10-02',
    },
    card_transactions: {
      id: 'card-txn-guard', card_account_id: 'card-acct-guard', source: 'amex-csv', external_id_hash: null,
      fingerprint: COFFEE_FINGERPRINT, transaction_date: '2026-10-01', posted_date: '2026-10-02', status: 'posted',
      amount_minor: 1250, currency: 'USD', original_amount_minor: 1100, original_currency: 'EUR', kind: 'purchase',
      description: 'BLUE BOTTLE COFFEE', merchant: 'Blue Bottle', issuer_category: 'Restaurant-Coffee',
      user_category: 'Coffee', notes: 'synthetic fixture', import_batch_id: 'card-import-guard',
      dismissed_at: null, created_at: at, updated_at: at,
      card_scope_id: LEGACY_SCOPE.id, revision: 1, first_sync_run_id: null, removed_reason: null, removed_from_status: null,
      removed_at: null, merged_into_id: null, reversal_snapshot_revision: null,
    },
  };

  function insertParents(db: RawDb, table: (typeof ORDER)[number]): void {
    for (const parent of ORDER.slice(0, ORDER.indexOf(table))) insertRow(db, parent, VALID[parent]);
    // v15: every card transaction is attributed to a card scope of its account.
    if (table === 'card_transactions') insertRow(db, 'card_scopes', LEGACY_SCOPE);
  }

  // Every representation below carries card data (the test PAN, or a labeled
  // security code) and must be refused in every column, on INSERT and on
  // UPDATE, with the problem the guard checks first for that column type.
  const POISONS: Array<{ label: string; text: unknown; integer: unknown; TEXT: string; INTEGER: string }> = [
    {
      label: 'ASCII digit run', text: `SYNTHETIC ${PAN} TEST`, integer: Number(PAN),
      TEXT: 'must not contain 13 or more consecutive digits', INTEGER: 'must not contain 13 or more consecutive digits',
    },
    {
      label: 'BLOB', text: Buffer.from(PAN), integer: Buffer.from(PAN),
      TEXT: 'must be stored as text', INTEGER: 'must be stored as an integer',
    },
    {
      label: 'NUL-embedded text', text: `safe\0${PAN}`, integer: `0\0${PAN}`,
      TEXT: 'must not contain NUL characters', INTEGER: 'must be stored as an integer',
    },
    {
      label: 'Arabic-Indic digits', text: ARABIC_INDIC_PAN, integer: ARABIC_INDIC_PAN,
      TEXT: 'must not contain non-ASCII digits or invisible characters', INTEGER: 'must be stored as an integer',
    },
    {
      label: 'grouped digits', text: '4111 1111 1111 1111', integer: '4111 1111 1111 1111',
      TEXT: 'must not contain a card number', INTEGER: 'must be stored as an integer',
    },
    {
      label: 'labeled security code', text: 'CVV 123', integer: 'CVV 123',
      TEXT: 'must not contain a card security code, PIN or expiry date', INTEGER: 'must be stored as an integer',
    },
  ];

  it.each(ORDER)('refuses every card data representation in every %s column on INSERT and UPDATE', (table) => {
    const db = rawDb(repo);
    insertParents(db, table);
    const valid = VALID[table];
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: 'TEXT' | 'INTEGER' }>;
    expect(Object.keys(valid).sort(), 'the fixture covers every column').toEqual(columns.map((c) => c.name).sort());
    const cases = columns.flatMap((column) => POISONS.map((poison) => ({
      column: column.name,
      label: poison.label,
      value: column.type === 'INTEGER' ? poison.integer : poison.text,
      message: new RegExp(`^${table}\\.${column.name} ${column.type === 'INTEGER' ? poison.INTEGER : poison.TEXT}$`),
    })));

    for (const { column, label, value, message } of cases) {
      expect(() => insertRow(db, table, { ...valid, [column]: value }), `INSERT ${column} ${label}`).toThrow(message);
    }
    insertRow(db, table, valid);
    for (const { column, label, value, message } of cases) {
      expect(() => db.prepare(`UPDATE ${table} SET "${column}" = ? WHERE id = ?`).run(value, valid.id), `UPDATE ${column} ${label}`)
        .toThrow(message);
    }
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([valid]);
  });

  it('rejects card numbers and long digit runs in every script, but allows 12 ASCII digits', () => {
    const db = rawDb(repo);
    insertParents(db, 'card_transactions');
    insertRow(db, 'card_transactions', VALID.card_transactions);
    const setDescription = db.prepare("UPDATE card_transactions SET description = ?, revision = revision + 1 WHERE id = 'card-txn-guard'");
    const expectProblem = (texts: string[], problem: string) => {
      for (const text of texts) {
        expect(() => setDescription.run(text), JSON.stringify(text))
          .toThrow(new RegExp(`^card_transactions\\.description ${problem}$`));
      }
    };
    expectProblem(
      [...TEST_CARD_NUMBERS, '1234567886593', 'PAID 4111111111111114254 OK', 'REF#378282246314205/A'],
      'must not contain 13 or more consecutive digits',
    );
    expectProblem(
      [
        // Arabic-Indic, Extended Arabic-Indic, Devanagari, Bengali, Thai,
        // fullwidth and mathematical bold digits.
        ...[0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50, 0xff10, 0x1d7ce].map(panInScript),
        'x12345678901２3y',
        '¹²³⁴⁵⁶⁷⁸⁹⁰¹²³',
        '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬',
        '4111\u200b1111\u200b1111\u200b1111',
        '4111\u20631111\u20631111\u20631111',
        'CAFÉ \u0663',
      ],
      'must not contain non-ASCII digits or invisible characters',
    );
    expectProblem(
      ['PAID 4111 1111 1111 1111', '4111-1111-1111-1111', 'AMEX 3782 822463 87649', 'ACCOUNT XXXX-XXXXXX-90003'],
      'must not contain a card number',
    );
    setDescription.run('ORDER 123456789012 PAID 4111-1111 CAFÉ');
    const setAmount = db.prepare("UPDATE card_transactions SET amount_minor = ?, revision = revision + 1 WHERE id = 'card-txn-guard'");
    setAmount.run(999_999_999_999);
    setAmount.run(-999_999_999_999);
    expect(() => setAmount.run(1_000_000_000_000)).toThrow(/^card_transactions\.amount_minor must not contain 13 or more/);
    expect(() => setAmount.run(-1_000_000_000_000)).toThrow(/^card_transactions\.amount_minor must not contain 13 or more/);
  });

  it('refuses every forbidden character at both ends of its range, past the ASCII pre-check', () => {
    const db = rawDb(repo);
    insertParents(db, 'card_transactions');
    insertRow(db, 'card_transactions', VALID.card_transactions);
    const setNotes = db.prepare("UPDATE card_transactions SET notes = ?, revision = revision + 1 WHERE id = 'card-txn-guard'");
    for (const [start, end] of CARD_TEXT_FORBIDDEN_RANGES) {
      for (const codePoint of new Set([start, end])) {
        expect(() => setNotes.run(`PAID ${String.fromCodePoint(codePoint)} OK`), codePoint.toString(16))
          .toThrow(/^card_transactions\.notes must not contain non-ASCII digits or invisible characters$/);
      }
    }
    for (const text of ['CAFÉ CRÈME', 'ZÜRICH HBF', 'SÃO PAULO', 'ŁÓDŹ KEBAB', '東京 ラーメン', 'NIÑO €5']) setNotes.run(text);
  });

  it('only lets connections with the Holdr card functions write card rows', () => {
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD' });
    const other = new Database(path.join(dir, 'finance.db'));
    try {
      expect(other.prepare('SELECT id, last4 FROM card_accounts').all()).toEqual([{ id: card.id, last4: '0003' }]);
      expect(() => other.prepare('UPDATE card_accounts SET nickname = ?').run('Gold'))
        .toThrow(new RegExp(`no such function: ${CARD_GUARD_BUILD.cardDataFunction}`));
      expect(() => insertRow(other, 'card_accounts', VALID.card_accounts))
        .toThrow(new RegExp(`no such function: ${CARD_GUARD_BUILD.cardDataFunction}`));
      other.prepare('VACUUM INTO ?').run(path.join(dir, 'other-backup.db'));
    } finally {
      other.close();
    }
    expect(repo.listCardAccounts()).toEqual([card]);
  });

  it('regenerates the guards on open, covering columns added later and replacing tampered triggers', () => {
    const file = path.join(dir, 'finance.db');
    repo.close();
    const db = new Database(file);
    db.exec(`
      ALTER TABLE card_transactions ADD COLUMN memo TEXT;
      DROP TRIGGER trg_card_accounts_guard_insert;
      DROP TRIGGER trg_card_accounts_guard_update;
      CREATE TRIGGER trg_card_accounts_guard_update BEFORE UPDATE ON card_accounts BEGIN SELECT 1; END;
      CREATE TRIGGER trg_card_accounts_long_digits_insert BEFORE INSERT ON card_accounts BEGIN SELECT 1; END;
    `);
    const stale = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_card_transactions_guard_insert'")
      .get() as { sql: string };
    expect(stale.sql).not.toContain('memo');
    db.close();

    repo = new SqliteStateRepo({ file });
    const reopened = rawDb(repo);
    // memo is guarded like every column, but this build's schema does not
    // define it, so messages call it <column>.
    for (const event of ['insert', 'update']) {
      const trigger = reopened.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
        .get(`trg_card_transactions_guard_${event}`) as { sql: string };
      expect(trigger.sql).toContain(`WHEN NEW."memo" GLOB '*${'[0-9]'.repeat(13)}*' ` +
        "THEN RAISE(ABORT, 'card_transactions.<column> must not contain 13 or more consecutive digits')");
      expect(trigger.sql).toContain(`WHEN instr(NEW."memo", char(0)) > 0 ` +
        "THEN RAISE(ABORT, 'card_transactions.<column> must not contain NUL characters')");
      expect(trigger.sql).not.toContain('card_transactions.memo');
    }
    expect(reopened.prepare(`SELECT name FROM sqlite_master WHERE ${GUARD_TRIGGERS} AND tbl_name = 'card_accounts' ORDER BY name`).all())
      .toEqual([{ name: 'trg_card_accounts_guard_insert' }, { name: 'trg_card_accounts_guard_update' }]);
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'trg_card_accounts_long_digits_insert'").get()).toBeUndefined();
    expect(() => insertRow(reopened, 'card_accounts', { ...VALID.card_accounts, nickname: '4111111111111111' }))
      .toThrow(/^card_accounts\.nickname must not contain/);
    insertParents(reopened, 'card_transactions');
    expect(() => reopened.prepare("UPDATE card_accounts SET nickname = ? WHERE id = 'card-acct-guard'").run('4111111111111111'))
      .toThrow(/^card_accounts\.nickname must not contain/);
    expect(() => insertRow(reopened, 'card_transactions', { ...VALID.card_transactions, memo: 'SYNTHETIC 4111111111111111' }))
      .toThrow(/^card_transactions\.<column> must not contain 13 or more consecutive digits$/);
  });

  it('re-checks stored rows with the guards\' own checks before it reinstalls dropped guards', () => {
    const file = path.join(dir, 'finance.db');
    repo.close();
    // An outside tool drops the guards and stores what they would refuse,
    // one poisoned column per row, wherever the CHECKs still let it.
    const db = new Database(file);
    for (const table of CARD_TABLES) db.exec(`DROP TRIGGER trg_${table}_guard_insert; DROP TRIGGER trg_${table}_guard_update`);
    insertParents(db, 'card_transactions');
    insertRow(db, 'card_transactions', VALID.card_transactions);
    const failures: string[] = [];
    const stored = new Set<string>();
    let attempt = 0;
    for (const table of ORDER) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: 'TEXT' | 'INTEGER' }>;
      // Every poisoned row fails and none has a generated id, so each is named
      // by its ordinal among the table's failing rows.
      let ordinal = 0;
      for (const column of columns) {
        for (const poison of POISONS) {
          attempt += 1;
          const row: Record<string, unknown> = {
            ...VALID[table],
            id: `${String(VALID[table].id)}-${attempt}`,
            ...(table === 'card_transactions' && {
              fingerprint: cardTransactionFingerprint({ transactionDate: '2026-10-01', amountMinor: attempt, description: 'X' }, 0),
            }),
            [column.name]: column.type === 'TEXT' ? poison.text : poison.integer,
          };
          try {
            insertRow(db, table, row);
          } catch {
            continue; // a CHECK refuses this value even without the guards
          }
          ordinal += 1;
          failures.push(`${table}.${column.name} in row #${ordinal} (non-standard id)`);
          stored.add(poison.label);
        }
      }
    }
    db.close();
    expect([...stored].sort(), 'every kind of poison got stored somewhere').toEqual(POISONS.map((p) => p.label).sort());
    expect(failures.length).toBeGreaterThan(20);

    const planted = POISONS.flatMap((poison) => [poison.text, poison.integer]).filter((v): v is string => typeof v === 'string');
    expectRefusedByteIdentical(file, storedRowsRefusal(failures.slice(0, 20), failures.length - 20), [...planted, PAN]);
    repo = new SqliteStateRepo({ file: path.join(dir, 'unrelated.db') });
  });

  it('stores amounts as integers and rejects fractions, text, blobs and out-of-range reals', () => {
    const db = rawDb(repo);
    insertParents(db, 'card_transactions');
    insertRow(db, 'card_transactions', VALID.card_transactions);
    expect(db.prepare('SELECT typeof(amount_minor) AS amount, typeof(original_amount_minor) AS original FROM card_transactions').get())
      .toEqual({ amount: 'integer', original: 'integer' });
    const bad = [12.5, -0.01, '12a', Buffer.from('12'), 1e300];
    // Every update of a card transaction moves its revision by one (v15).
    for (const column of ['amount_minor', 'original_amount_minor']) {
      const update = db.prepare(`UPDATE card_transactions SET ${column} = ?, revision = revision + 1 WHERE id = 'card-txn-guard'`);
      for (const value of bad) {
        expect(() => update.run(value), `${column} = ${String(value)}`)
          .toThrow(new RegExp(`^card_transactions\\.${column} must be stored as an integer$`));
      }
      update.run('42');
      expect(db.prepare(`SELECT ${column} AS value, typeof(${column}) AS type FROM card_transactions`).get())
        .toEqual({ value: 42, type: 'integer' });
    }
    // The CHECKs refuse the same values on their own.
    db.exec('DROP TRIGGER trg_card_transactions_guard_update');
    for (const column of ['amount_minor', 'original_amount_minor']) {
      const update = db.prepare(`UPDATE card_transactions SET ${column} = ?, revision = revision + 1 WHERE id = 'card-txn-guard'`);
      for (const value of bad) {
        expect(() => update.run(value), `${column} = ${String(value)}`).toThrow(new RegExp(`CHECK constraint failed: .*${column}`));
      }
    }
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', currency: 'USD' });
    for (const amountMinor of [12.5, 2 ** 53, 1_000_000_000_000, Number.NaN]) {
      expect(() => repo.importCardTransactions(cardImport(card.id, [cardRow({ amountMinor })])))
        .toThrow(/^rows\[0\]\.amountMinor must be whole minor units/);
    }
  });

  it('accepts only versioned letter-hex dedupe keys, exactly one per row', () => {
    const db = rawDb(repo);
    insertParents(db, 'card_transactions');
    const valid = VALID.card_transactions;
    const invalid: Array<Record<string, unknown>> = [
      { fingerprint: null },
      { external_id_hash: AMEX_REFERENCE },
      { fingerprint: `cfp1:${'a'.repeat(63)}0` },
      { fingerprint: COFFEE_FINGERPRINT.toUpperCase() },
      { fingerprint: `cfp1:${'a'.repeat(63)}` },
      { fingerprint: AMEX_REFERENCE },
      { fingerprint: null, external_id_hash: 'FITID-REF-ABC' },
      { fingerprint: null, external_id_hash: COFFEE_FINGERPRINT },
      { fingerprint: null, external_id_hash: AMEX_REFERENCE.toUpperCase() },
      { fingerprint: null, external_id_hash: AMEX_REFERENCE.replace('xid1:', 'xid0:') },
    ];
    for (const patch of invalid) {
      expect(() => insertRow(db, 'card_transactions', { ...valid, ...patch }), JSON.stringify(patch)).toThrow(/CHECK constraint failed/);
    }
    insertRow(db, 'card_transactions', valid);
    insertRow(db, 'card_transactions', { ...valid, id: 'card-txn-reference', fingerprint: null, external_id_hash: AMEX_REFERENCE });
    // v15: a row's key is the key of the observation that created it, no
    // longer unique among rows (two sources may create rows sharing one);
    // a key's identity is its source identity tuple, which is unique.
    insertRow(db, 'card_transactions', { ...valid, id: 'card-txn-again' });
    const identity = (id: string, transactionId: string, key: string) => insertRow(db, 'card_source_identities', {
      id, card_account_id: 'card-acct-guard', source_scope_id: LEGACY_SCOPE.id, source_scope_kind: 'legacy',
      namespace: 'legacy-file:v1', namespace_kind: 'legacy-file', id_hash: key, canonical_transaction_id: transactionId,
      status: 'active', first_seen_status: 'posted', created_origin: 'file', import_batch_id: 'card-import-guard',
      first_observation_id: null, created_at: at, last_seen_at: null, last_seen_run_id: null,
    });
    identity(`card-ident-${'a'.repeat(32)}`, valid.id as string, COFFEE_FINGERPRINT);
    expect(() => identity(`card-ident-${'b'.repeat(32)}`, 'card-txn-again', COFFEE_FINGERPRINT))
      .toThrow(/card invariant: card_source_identities rows are never replaced/);
  });
});

describe('SqliteStateRepo value-free refusals (v13)', () => {
  // Refusals end up in startup logs, so none may repeat anything stored: not
  // a value, not a rowid, not a column name or id this build did not create.
  const GENERATED_ACCOUNT_ID = `card-acct-${'b'.repeat(32)}`;
  const OTHER_TABLE_ID = `card-txn-${'c'.repeat(32)}`;
  const PAN_COLUMN = `pan_${PAN}`;

  /**
   * finance.db after an outside tool dropped the card guards and ran `tamper`
   * on a raw connection, so the next open re-checks every card row.
   */
  function tampered(tamper: (db: RawDb) => void): string {
    const file = path.join(dir, 'finance.db');
    repo.close();
    const db = new Database(file);
    try {
      // Every card table: a write to one can fire triggers that write another
      // (v15's snapshots), and each guard calls functions only Holdr registers.
      for (const table of CARD_TABLES) {
        db.exec(`DROP TRIGGER trg_${table}_guard_insert; DROP TRIGGER trg_${table}_guard_update`);
      }
      tamper(db);
    } finally {
      db.close();
    }
    return file;
  }

  /** Refused exactly with `message`, byte-identical and value-free; afterEach then closes an unrelated database. */
  function expectRefused(file: string, message: string, planted: readonly string[]): void {
    expectRefusedByteIdentical(file, message, planted);
    repo = new SqliteStateRepo({ file: path.join(dir, 'unrelated.db') });
  }

  it('never prints a column that shadows rowid, nor an id it cannot vouch for', () => {
    const file = tampered((db) => {
      db.exec('ALTER TABLE card_accounts ADD COLUMN rowid TEXT');
      insertRow(db, 'card_accounts', { id: 'card-acct-raw', issuer: 'amex', owner: 'alex', currency: 'USD', rowid: 'CVV 123' });
    });
    expectRefused(file, storedRowsRefusal(['card_accounts.<column> in row #1 (non-standard id)']), [
      'CVV 123', 'card-acct-raw', 'rowid',
    ]);
  });

  it('never prints the internal rowid, which a caller can set to a card number', () => {
    const file = tampered((db) => {
      const insert = db.prepare(
        "INSERT INTO card_accounts (rowid, id, issuer, owner, nickname, currency) VALUES (?, ?, 'amex', 'alex', ?, 'USD')",
      );
      insert.run(BigInt(PAN), 'card-acct-raw', 'CVV 123');
      insert.run(BigInt(TEST_CARD_NUMBERS[1]), GENERATED_ACCOUNT_ID, 'exp 12/29');
    });
    expectRefused(file, storedRowsRefusal([
      'card_accounts.nickname in row #1 (non-standard id)',
      `card_accounts.nickname in row ${GENERATED_ACCOUNT_ID}`,
    ]), [PAN, TEST_CARD_NUMBERS[1], 'CVV 123', 'exp 12/29', 'card-acct-raw', 'rowid']);
  });

  it('never prints columns that shadow oid or _rowid_', () => {
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' });
    repo.importCardTransactions(cardImport(card.id, [cardRow()]));
    const [txn] = repo.listCardTransactions();
    const file = tampered((db) => {
      db.exec('ALTER TABLE card_transactions ADD COLUMN oid TEXT; ALTER TABLE card_transactions ADD COLUMN _rowid_ TEXT');
      db.prepare('UPDATE card_transactions SET oid = ?, _rowid_ = ?, revision = revision + 1').run('4111 1111 1111 1111', 'exp 12/29');
    });
    expectRefused(file, storedRowsRefusal([
      `card_transactions.<column> in row ${txn.id}`,
      `card_transactions.<column> in row ${txn.id}`,
    ]), ['4111 1111 1111 1111', 'exp 12/29', '_rowid_']);
  });

  it('never prints a column name this build does not define, not even in the guards it installs', () => {
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' });
    repo.importCardTransactions(cardImport(card.id, [cardRow(), cardRow()]));
    const [first, second] = repo.listCardTransactions();
    const file = tampered((db) => {
      db.exec(`ALTER TABLE card_transactions ADD COLUMN ${PAN_COLUMN} TEXT`);
      db.prepare(`UPDATE card_transactions SET ${PAN_COLUMN} = ?, revision = revision + 1 WHERE id = ?`).run('CVV 123', first.id);
    });
    expectRefused(file, storedRowsRefusal([`card_transactions.<column> in row ${first.id}`]), [PAN, 'CVV 123']);

    // Once its values pass, the column is guarded, and named <column> there too.
    const fix = new Database(file);
    fix.prepare(`UPDATE card_transactions SET ${PAN_COLUMN} = NULL, revision = revision + 1`).run();
    fix.close();
    repo.close();
    repo = new SqliteStateRepo({ file });
    const db = rawDb(repo);
    for (const event of ['insert', 'update']) {
      const { sql } = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
        .get(`trg_card_transactions_guard_${event}`) as { sql: string };
      expect(sql).toContain(`${CARD_GUARD_BUILD.cardSecretFunction}(NEW."${PAN_COLUMN}")`);
      expect(sql).not.toContain(`'card_transactions.${PAN_COLUMN}`);
    }
    let message = '';
    try {
      db.prepare(`UPDATE card_transactions SET ${PAN_COLUMN} = ?, revision = revision + 1 WHERE id = ?`).run('CVV 123', second.id);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('card_transactions.<column> must not contain a card security code, PIN or expiry date');
    expectValueFree(message, [PAN, 'CVV 123']);

    // A type the guards do not cover is refused under the same rule.
    repo.close();
    const alter = new Database(file);
    alter.exec(`ALTER TABLE card_accounts ADD COLUMN ${PAN_COLUMN} BLOB`);
    alter.close();
    expectRefused(file, 'card_accounts.<column> has a type the card guards do not cover', [PAN]);
  });

  it('names only this build\'s own columns, and ids in the format of their own table', () => {
    const fresh = rawDb(repo).prepare(`SELECT sql FROM sqlite_master WHERE ${GUARD_TRIGGERS}`).all() as Array<{ sql: string }>;
    expect(fresh).toHaveLength(2 * CARD_TABLES.length);
    for (const { sql } of fresh) expect(sql, 'every column of the schema is named').not.toContain('<column>');
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' });
    const batch = repo.importCardTransactions(cardImport(card.id, [cardRow()]));
    const [txn] = repo.listCardTransactions();
    const file = tampered((db) => {
      db.prepare('UPDATE card_accounts SET nickname = ?').run('CVV 123');
      insertRow(db, 'card_accounts', { id: OTHER_TABLE_ID, issuer: 'amex', owner: 'alex', currency: 'USD', nickname: 'CVV 456' });
      db.prepare('UPDATE card_import_batches SET source = ?').run('exp 12/29');
      db.prepare('UPDATE card_transactions SET notes = ?, revision = revision + 1').run('4111 1111 1111 1111');
    });
    expectRefused(file, storedRowsRefusal([
      `card_accounts.nickname in row ${card.id}`,
      'card_accounts.nickname in row #2 (non-standard id)',
      `card_import_batches.source in row ${batch.id}`,
      `card_transactions.notes in row ${txn.id}`,
    ]), ['CVV 123', 'CVV 456', 'exp 12/29', '4111 1111 1111 1111', OTHER_TABLE_ID]);
  });

  it('counts failures past the first 20 without listing them', () => {
    const planted: string[] = [];
    const file = tampered((db) => {
      const insert = db.prepare(
        "INSERT INTO card_accounts (rowid, id, issuer, owner, nickname, currency) VALUES (?, ?, 'amex', 'alex', ?, 'USD')",
      );
      for (let i = 0; i < 25; i += 1) {
        const values = [BigInt(PAN) + BigInt(i), `card-acct-raw-${i}`, `CVV ${100 + i}`] as const;
        insert.run(...values);
        planted.push(...values.map(String));
      }
    });
    const listed = Array.from({ length: 20 }, (_, i) => `card_accounts.nickname in row #${i + 1} (non-standard id)`);
    expectRefused(file, storedRowsRefusal(listed, 5), planted);
  });

  it('shows a tampered guard revision or schema version only as a bound', () => {
    const file = path.join(dir, 'finance.db');
    repo.close();
    const db = new Database(file);
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_card_accounts_guard_insert'")
      .get() as { sql: string };
    db.exec('DROP TRIGGER trg_card_accounts_guard_insert');
    db.exec(sql.replace(revisionLine(GUARD_REVISION), revisionLine(Number(PAN))));
    db.close();
    expectRefused(file, `card guards are revision 1000 or higher, newer than this build's ${GUARD_REVISION}; ` +
      'refusing to open the database. Run the newer build, or restore a backup made by this one.', [PAN]);

    const other = path.join(dir, 'version.db');
    new SqliteStateRepo({ file: other }).close();
    const raw = new Database(other);
    raw.pragma('user_version = 2147483647');
    raw.close();
    expectRefusedByteIdentical(other, 'database schema v1000 or higher is newer than this build supports (v15); ' +
      'refusing to open it. Run the newer build, or restore a backup made by this one.', ['2147483647']);
  });
});

describe('SqliteStateRepo value-free database errors (v13)', () => {
  // SQLite's own messages can quote identifiers, constraint names and the text
  // a foreign trigger raises. None of that may leave the repository.
  const PAN_NAME = `pan_${PAN}`;
  const SECRET = 'CVV 123';
  const PLANTED = [PAN, PAN_NAME, SECRET];
  const validCard = { issuer: 'amex', owner: 'alex', currency: 'USD' } as const;

  function caught(fn: () => unknown): Error {
    try {
      fn();
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a failure');
  }

  /** No cause, and nothing planted wherever `error` could be shown: message, stack, JSON, inspection, keys. */
  function expectSafe(error: Error): void {
    expect('cause' in error).toBe(false);
    const shown = [error.message, String(error.stack), JSON.stringify(error), util.inspect(error), String(error)];
    for (const text of [...shown, Object.keys(error).join()]) expectValueFree(text, PLANTED);
  }

  /** A frozen HoldrDbError for `operation` and `code` and nothing else. */
  function expectValueFreeDbError(error: Error, operation: string, code: string): void {
    expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
    expect(error).toMatchObject({ name: 'HoldrDbError', message: `${operation} failed (${code})`, operation, code });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(['code', 'message', 'operation', 'stack']);
    expectSafe(error);
  }

  /** A fresh, frozen HoldrGuardRefusal holding `message`, a card guard template, and nothing else. */
  function expectGuardRefusal(error: Error, message: string): void {
    expect(Object.getPrototypeOf(error)).toBe(HoldrGuardRefusal.prototype);
    expect(error).toMatchObject({ name: 'HoldrGuardRefusal', message, code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(['code', 'message', 'stack']);
    expect(isCardGuardRefusal(error)).toBe(true);
    expect(valueFreeDbCode(error)).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expectSafe(error);
  }

  it('opens no database whose backfill trips a foreign trigger, and quotes none of it', () => {
    const file = path.join(dir, 'finance.db');
    repo.close();
    const db = new Database(file);
    db.exec(`CREATE TRIGGER foreign_audit AFTER INSERT ON account_history_invalidations BEGIN SELECT ${PAN_NAME}; END`);
    db.close();
    const error = expectRefusedByteIdentical(file, 'open database failed (SQLITE_ERROR)', PLANTED);
    expectValueFreeDbError(error, 'open database', 'SQLITE_ERROR');
    repo = new SqliteStateRepo({ file: path.join(dir, 'unrelated.db') });
  });

  it('quotes neither a foreign trigger\'s message nor a constraint\'s name on a card write', () => {
    const db = rawDb(repo);
    db.exec(`CREATE TRIGGER foreign_note BEFORE INSERT ON card_accounts BEGIN SELECT RAISE(ABORT, '${SECRET} ${PAN}'); END`);
    expectValueFreeDbError(caught(() => repo.createCardAccount(validCard)), 'create card account', 'SQLITE_CONSTRAINT_TRIGGER');
    db.exec('DROP TRIGGER foreign_note');

    db.exec(`ALTER TABLE card_accounts ADD COLUMN extra TEXT CONSTRAINT ${PAN_NAME} CHECK (extra IS NOT NULL)`);
    expectValueFreeDbError(caught(() => repo.createCardAccount(validCard)), 'create card account', 'SQLITE_CONSTRAINT_CHECK');
    expect(repo.listCardAccounts()).toEqual([]);
  });

  it('rolls back an import a foreign trigger stops, and quotes nothing of it', () => {
    const card = repo.createCardAccount(validCard);
    rawDb(repo).exec(
      `CREATE TRIGGER foreign_row BEFORE INSERT ON card_transactions BEGIN SELECT RAISE(ABORT, '${SECRET} ${PAN}'); END`,
    );
    expectValueFreeDbError(
      caught(() => repo.importCardTransactions(cardImport(card.id, [cardRow()]))), 'import card transactions', 'SQLITE_CONSTRAINT_TRIGGER',
    );
    expect(repo.listCardImportBatches()).toEqual([]);
    expect(repo.listCardTransactions()).toEqual([]);
  });

  it('quotes no stored identifier when a card read fails', () => {
    rawDb(repo).exec(`
      ALTER TABLE card_accounts RENAME TO card_accounts_kept;
      CREATE TABLE ${PAN_NAME} (id TEXT);
      CREATE VIEW card_accounts AS SELECT * FROM ${PAN_NAME};
      DROP TABLE ${PAN_NAME};
    `);
    expectValueFreeDbError(caught(() => repo.listCardAccounts()), 'list card accounts', 'SQLITE_ERROR');
    expectValueFreeDbError(caught(() => repo.getCardAccount('card-acct-raw')), 'read card account', 'SQLITE_ERROR');
  });

  it('rebuilds a trigger refusal as a guard refusal only when it is exactly one of the guards\' messages', () => {
    const db = rawDb(repo);
    const guardMessage = 'card_accounts.nickname must not contain a card number';
    db.exec(`CREATE TRIGGER foreign_guard BEFORE INSERT ON card_accounts BEGIN SELECT RAISE(ABORT, '${guardMessage}'); END`);
    expectGuardRefusal(caught(() => repo.createCardAccount(validCard)), guardMessage);

    db.exec('DROP TRIGGER foreign_guard');
    db.exec(
      `CREATE TRIGGER foreign_guard BEFORE INSERT ON card_accounts BEGIN SELECT RAISE(ABORT, '${guardMessage} ${PAN}'); END`,
    );
    expectValueFreeDbError(caught(() => repo.createCardAccount(validCard)), 'create card account', 'SQLITE_CONSTRAINT_TRIGGER');
  });

  // What a registered SQL function can throw from inside a guard trigger or the
  // re-check: anything at all. The card number detector below throws it when
  // it sees the owner `joint`, which only the SQL guards ever pass to it.
  const TRAPPED_OWNER = 'joint';
  const trapping = (payload: () => unknown): CardGuardBuild => ({
    ...CARD_GUARD_BUILD,
    detectors: {
      containsCardData: (text) => {
        if (text === TRAPPED_OWNER) throw payload();
        return containsCardData(text);
      },
      containsCardSecret,
    },
  });
  const GUARD_MESSAGE = 'card_accounts.nickname must not contain a card number';
  const OWN_REFUSAL = 'nickname must not contain a card number or 13 or more consecutive digits';
  /** Sets `error`'s stack to planted text as sloppy-mode code would; a pinned stack ignores it. */
  const sloppyAssignStack = new Function('error', 'value', 'error.stack = value; return error;') as
    (error: unknown, value: string) => unknown;
  const sloppyStack = <T>(error: T): T => sloppyAssignStack(error, `${SECRET} ${PAN}`) as T;
  const PAYLOADS: Array<[string, () => unknown, (error: Error, operation: string) => void]> = [
    [
      'a guard refusal carrying an earlier stack, a cause and more',
      () => {
        const error = new Database.SqliteError(`${SECRET} ${PAN}`, 'SQLITE_CONSTRAINT_TRIGGER');
        void error.stack;
        error.message = GUARD_MESSAGE;
        return Object.assign(error, { cause: new Error(PAN), context: `${SECRET} ${PAN}` });
      },
      (error) => expectGuardRefusal(error, GUARD_MESSAGE),
    ],
    [
      'a plain error',
      () => Object.assign(new Error(`${SECRET} ${PAN}`), { cause: PAN }),
      (error, operation) => expectValueFreeDbError(error, operation, 'UNKNOWN'),
    ],
    [
      'a HoldrRefusal after an attempt to rewrite its stack',
      () => sloppyStack(new HoldrRefusal(OWN_REFUSAL)),
      (error) => {
        expect(Object.getPrototypeOf(error)).toBe(HoldrRefusal.prototype);
        expect(error.message).toBe(OWN_REFUSAL);
        expect(String(error.stack)).toMatch(new RegExp(`^HoldrRefusal: ${OWN_REFUSAL}\n`));
        expect(Object.isFrozen(error)).toBe(true);
        expectSafe(error);
      },
    ],
    [
      'a HoldrDbError after an attempt to rewrite its stack',
      () => sloppyStack(new HoldrDbError('read card account', 'SQLITE_BUSY')),
      (error) => {
        expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
        expect(String(error.stack)).toMatch(/^HoldrDbError: read card account failed \(SQLITE_BUSY\)\n/);
        expectSafe(error);
      },
    ],
    [
      'a HoldrGuardRefusal after an attempt to rewrite its stack',
      () => sloppyStack(new HoldrGuardRefusal(GUARD_MESSAGE)),
      (error) => {
        expectGuardRefusal(error, GUARD_MESSAGE);
        expect(String(error.stack)).toMatch(new RegExp(`^HoldrGuardRefusal: ${GUARD_MESSAGE}\n`));
      },
    ],
    [
      'a lookalike of Holdr\'s refusals',
      () => Object.create(HoldrRefusal.prototype, { message: { value: `${SECRET} ${PAN}` }, cause: { value: PAN } }),
      (error, operation) => expectValueFreeDbError(error, operation, 'UNKNOWN'),
    ],
    ['a string', () => `${SECRET} ${PAN}`, (error, operation) => expectValueFreeDbError(error, operation, 'UNKNOWN')],
    [
      'a plain object',
      () => ({ pan: PAN, message: GUARD_MESSAGE, code: 'SQLITE_CONSTRAINT_TRIGGER' }),
      (error, operation) => expectValueFreeDbError(error, operation, 'SQLITE_CONSTRAINT_TRIGGER'),
    ],
  ];

  it('freezes Holdr\'s own refusals, so none can gain a cause or another property on its way out', () => {
    const refusal = new HoldrRefusal(OWN_REFUSAL);
    expect(() => Object.assign(refusal, { cause: PAN })).toThrow(TypeError);
    expect(() => Object.defineProperty(refusal, 'context', { value: SECRET })).toThrow(TypeError);
    expect(Object.getOwnPropertyNames(refusal).sort()).toEqual(['message', 'stack']);
  });

  it.each(PAYLOADS)('lets nothing of %s out of createCardAccount', (_label, payload, expectResult) => {
    repo.close();
    repo = new SqliteStateRepo({ file: path.join(dir, 'trap.db'), cardGuards: trapping(payload) });
    expectResult(caught(() => repo.createCardAccount({ ...validCard, owner: TRAPPED_OWNER })), 'create card account');
    expect(repo.listCardAccounts()).toEqual([]);
  });

  it.each(PAYLOADS)('lets nothing of %s out of the stored-row re-check, and changes nothing', (_label, payload, expectResult) => {
    const file = path.join(dir, 'finance.db');
    repo.createCardAccount({ ...validCard, owner: TRAPPED_OWNER });
    repo.close();
    // A missing guard makes the next open re-check the table's stored rows.
    const db = new Database(file);
    db.exec('DROP TRIGGER trg_card_accounts_guard_insert');
    db.close();
    const before = fileState(file);
    expectResult(caught(() => new SqliteStateRepo({ file, cardGuards: trapping(payload) })), 'open database');
    expect(fileState(file)).toEqual(before);
    repo = new SqliteStateRepo({ file: path.join(dir, 'unrelated.db') });
  });

  it('puts every card method behind the boundary and passes Holdr\'s own refusals unchanged', () => {
    const cardMethods = Object.getOwnPropertyNames(SqliteStateRepo.prototype).filter((name) => /card/i.test(name));
    expect(Object.keys(CARD_REPO_OPERATIONS).sort()).toEqual(cardMethods.sort());
    const refusal = caught(() => repo.createCardAccount({ ...validCard, nickname: '4111 1111 1111 1111' }));
    expect(refusal).toBeInstanceOf(HoldrRefusal);
    expect(refusal.message).toBe('nickname must not contain a card number or 13 or more consecutive digits');
    const missing = caught(() => repo.importCardTransactions(cardImport('card-acct-missing', [cardRow()])));
    expect(missing).toBeInstanceOf(HoldrRefusal);
    expect(missing.message).toBe('card account does not exist');
  });

  it('knows exactly the messages the guards raise, and the schema they are built from', () => {
    // The guards' own triggers; v15's invariant triggers raise constants of their own (`card invariant: …`).
    const raised = (db: RawDb) => (db.prepare(`SELECT sql FROM sqlite_master WHERE ${GUARD_TRIGGERS}`)
      .all() as Array<{ sql: string }>).flatMap(({ sql }) => [...sql.matchAll(/RAISE\(ABORT, '([^']*)'\)/g)].map((m) => m[1]));
    for (const table of CARD_TABLES) {
      const columns = rawDb(repo).prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
      expect(new Map(columns.map((column) => [column.name, column.type])), table).toEqual(CARD_SCHEMA[table].columns);
    }
    const card = repo.createCardAccount(validCard);
    const batch = repo.importCardTransactions(cardImport(card.id, [cardRow()]));
    expect(card.id).toMatch(CARD_SCHEMA.card_accounts.generatedId);
    expect(batch.id).toMatch(CARD_SCHEMA.card_import_batches.generatedId);
    expect(repo.listCardTransactions()[0].id).toMatch(CARD_SCHEMA.card_transactions.generatedId);
    const fresh = raised(rawDb(repo));

    // Columns this build's schema does not define, one of each type, on every card table.
    const file = path.join(dir, 'finance.db');
    repo.close();
    const db = new Database(file);
    for (const table of CARD_TABLES) db.exec(`ALTER TABLE ${table} ADD COLUMN extra_text TEXT; ALTER TABLE ${table} ADD COLUMN extra_count INTEGER`);
    db.close();
    repo = new SqliteStateRepo({ file });
    expect([...new Set([...fresh, ...raised(rawDb(repo))])].sort()).toEqual([...CARD_GUARD_MESSAGES].sort());
  });
});

describe('SqliteStateRepo card transaction import (v13)', () => {
  let cardId: string;

  beforeEach(() => {
    cardId = repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Gold', last4: '0003', currency: 'USD' }).id;
  });

  it('stores a redacted export with provenance, counts and letters-only ids', () => {
    const batch = repo.importCardTransactions(cardImport(cardId, [
      cardRow({ externalIdHash: AMEX_REFERENCE, originalAmountMinor: 1100, originalCurrency: 'EUR' }),
      cardRow(),
      cardRow({ postedDate: null, status: 'pending', merchant: '', issuerCategory: undefined }),
    ], { rejectedCount: 2 }));
    expect(batch).toMatchObject({
      cardAccountId: cardId, source: 'amex-csv', parserVersion: 'amex-csv@1',
      rowCount: 5, newCount: 3, duplicateCount: 0, rejectedCount: 2,
    });
    expect(batch.id).toMatch(/^card-import-[a-p]{32}$/);
    expect(cardId).toMatch(/^card-acct-[a-p]{32}$/);
    expect(repo.listCardImportBatches(cardId)).toEqual([batch]);

    const rows = repo.listCardTransactions({ cardAccountId: cardId });
    expect(rows.map((row) => [row.externalIdHash, row.fingerprint])).toEqual([
      [AMEX_REFERENCE, undefined],
      [undefined, COFFEE_FINGERPRINT],
      [undefined, cardTransactionFingerprint({ transactionDate: '2026-10-01', amountMinor: 1250, description: 'BLUE BOTTLE COFFEE' }, 1)],
    ]);
    expect(rows[0]).toMatchObject({
      cardAccountId: cardId, source: 'amex-csv', transactionDate: '2026-10-01', postedDate: '2026-10-02', status: 'posted',
      amountMinor: 1250, currency: 'USD', originalAmountMinor: 1100, originalCurrency: 'EUR', kind: 'purchase',
      description: 'BLUE BOTTLE COFFEE', merchant: 'Blue Bottle', issuerCategory: 'Restaurant-Coffee', importBatchId: batch.id,
    });
    expect(rows[2]).toMatchObject({ status: 'pending', postedDate: undefined, merchant: undefined, issuerCategory: undefined });
    for (const row of rows) expect(row.id).toMatch(/^card-txn-[a-p]{32}$/);
  });

  it('stores free text normalized, so re-imports of either form dedupe', () => {
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: ' Ｇｏｌｄ\u200b ２ ', currency: 'USD' });
    expect(card.nickname).toBe('Gold 2');
    const unnormalized = cardRow({ description: 'BLUE BOTTLE ＃\u0664\u0662\u2063', merchant: 'Blue\u00ad Bottle' });
    repo.importCardTransactions(cardImport(cardId, [unnormalized]));
    expect(repo.listCardTransactions({ cardAccountId: cardId })[0]).toMatchObject({
      description: 'BLUE BOTTLE #42',
      merchant: 'Blue Bottle',
      fingerprint: cardTransactionFingerprint({ transactionDate: '2026-10-01', amountMinor: 1250, description: 'BLUE BOTTLE #42' }, 0),
    });
    expect(repo.importCardTransactions(cardImport(cardId, [cardRow({ description: 'BLUE BOTTLE #42' })])))
      .toMatchObject({ newCount: 0, duplicateCount: 1 });
  });

  it('keeps two identical purchases without ids, and adds nothing when the export comes in again', () => {
    const twoCoffees = [cardRow(), cardRow()];
    expect(repo.importCardTransactions(cardImport(cardId, twoCoffees))).toMatchObject({ newCount: 2, duplicateCount: 0 });
    // The same export from a second computer: same keys, no salt.
    expect(repo.importCardTransactions(cardImport(cardId, twoCoffees))).toMatchObject({ newCount: 0, duplicateCount: 2 });
    // A later export that has a third identical purchase that day.
    expect(repo.importCardTransactions(cardImport(cardId, [cardRow(), cardRow(), cardRow()])))
      .toMatchObject({ newCount: 1, duplicateCount: 2 });
    const rows = repo.listCardTransactions({ cardAccountId: cardId });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(3);
  });

  it('counts occurrences only among id-less rows, whether or not an id-bearing twin is in the export', () => {
    repo.importCardTransactions(cardImport(cardId, [cardRow({ externalIdHash: AMEX_REFERENCE }), cardRow()]));
    expect(repo.importCardTransactions(cardImport(cardId, [cardRow()]))).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.listCardTransactions({ cardAccountId: cardId })).toHaveLength(2);
  });

  it('dedupes by external id hash per card account, including repeats inside one export', () => {
    const other = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '2002', currency: 'USD' }).id;
    const referenced = cardRow({ externalIdHash: AMEX_REFERENCE });
    expect(repo.importCardTransactions(cardImport(cardId, [referenced, { ...referenced, amountMinor: 999 }])))
      .toMatchObject({ rowCount: 2, newCount: 1, duplicateCount: 1 });
    expect(repo.importCardTransactions(cardImport(cardId, [referenced]))).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.importCardTransactions(cardImport(other, [referenced]))).toMatchObject({ newCount: 1, duplicateCount: 0 });
    expect(repo.listCardTransactions({ cardAccountId: cardId }).map((row) => row.amountMinor)).toEqual([1250]);
    expect(repo.listCardTransactions()).toHaveLength(2);
  });

  it('filters transactions by inclusive date bounds', () => {
    repo.importCardTransactions(cardImport(cardId, [
      cardRow({ transactionDate: '2026-09-30' }),
      cardRow({ transactionDate: '2026-10-01' }),
      cardRow({ transactionDate: '2026-10-31' }),
      cardRow({ transactionDate: '2026-11-01' }),
    ]));
    expect(repo.listCardTransactions({ from: '2026-10-01', to: '2026-10-31' }).map((row) => row.transactionDate))
      .toEqual(['2026-10-01', '2026-10-31']);
    expect(() => repo.listCardTransactions({ from: '2026-13-01' })).toThrow(/from date/);
  });

  it.each([
    ['grouped card number', { description: 'PAID 4111 1111 1111 1111' }, /^rows\[1\]\.description must not contain a card number/],
    ['zero-width-split card number', { description: 'PAID 4111\u200b1111\u200b1111\u200b1111' }, /^rows\[1\]\.description must not contain/],
    ['13 Arabic-Indic digits', { description: 'REF \u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660\u0661\u0662\u0663' }, /^rows\[1\]\.description must not contain/],
    ['masked number revealing more than four digits', { merchant: 'AMEX XXXX-XXXXXX-90003' }, /^rows\[1\]\.merchant must not contain/],
    ['card number in the issuer category', { issuerCategory: '5555555555554444' }, /^rows\[1\]\.issuerCategory must not contain/],
    ['raw reference instead of its hash', { externalIdHash: '320252940123456789' }, /^rows\[1\]\.externalIdHash must come from cardExternalIdHash$/],
    ['hex digest instead of letter hex', { externalIdHash: `xid1:${'0123456789abcdef'.repeat(4)}` }, /^rows\[1\]\.externalIdHash/],
    ['currency other than the card account', { currency: 'EUR' }, /^rows\[1\]\.currency must match the card account currency$/],
    ['original amount without currency', { originalAmountMinor: 1100 }, /^rows\[1\]\.originalAmountMinor and originalCurrency/],
    ['impossible date', { transactionDate: '2026-02-30' }, /^rows\[1\]\.transactionDate/],
    ['unknown kind', { kind: 'transfer' as never }, /^rows\[1\]\.kind/],
    ['unknown status', { status: 'cleared' as never }, /^rows\[1\]\.status/],
    ['empty description', { description: '   ' }, /^rows\[1\]\.description must not be empty$/],
    ['control characters', { description: 'BLUE\nBOTTLE' }, /^rows\[1\]\.description must not contain control characters$/],
    ['oversized description', { description: 'A'.repeat(501) }, /^rows\[1\]\.description must be at most 500 characters$/],
  ])('rejects the whole import for %s, naming the field but never the value', (_label, patch, expected) => {
    let error: Error | undefined;
    try {
      repo.importCardTransactions(cardImport(cardId, [cardRow(), cardRow(patch as Partial<CardImportRow>)]));
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(expected);
    expect(error?.message).not.toMatch(/4111|5555|90003|3202|\u0661/);
    expect(repo.listCardTransactions()).toEqual([]);
    expect(repo.listCardImportBatches()).toEqual([]);
  });

  it('validates import and card account metadata', () => {
    expect(() => repo.importCardTransactions(cardImport('card-acct-missing', [cardRow()]))).toThrow(/^card account does not exist$/);
    expect(() => repo.importCardTransactions(cardImport(cardId, []))).toThrow(/^rows must contain between 1 and 10000 rows$/);
    expect(() => repo.importCardTransactions(cardImport(cardId, [cardRow()], { source: 'Amex CSV' }))).toThrow(/^source is invalid$/);
    expect(() => repo.importCardTransactions(cardImport(cardId, [cardRow()], { source: 'a4111111111111111' })))
      .toThrow(/^source must not contain/);
    expect(() => repo.importCardTransactions(cardImport(cardId, [cardRow()], { rejectedCount: -1 }))).toThrow(/^rejectedCount/);
    const base = { issuer: 'amex', owner: 'alex' as const, currency: 'USD' };
    expect(() => repo.createCardAccount({ ...base, issuer: 'American Express' })).toThrow(/^issuer is invalid$/);
    expect(() => repo.createCardAccount({ ...base, owner: 'guest' as never })).toThrow(/^owner must be alex, casey or joint$/);
    expect(() => repo.createCardAccount({ ...base, currency: 'usd' })).toThrow(/^currency is invalid$/);
    expect(() => repo.createCardAccount({ ...base, status: 'frozen' as never })).toThrow(/^status must be active or closed$/);
    expect(() => repo.createCardAccount({ ...base, nickname: 'Card 4111 1111 1111 1111' })).toThrow(/^nickname must not contain a card number/);
    expect(repo.listCardAccounts()).toHaveLength(1);
  });

  it('survives backup and restore with rows, guards and dedupe intact, and no card number on disk', async () => {
    const rows = [cardRow({ externalIdHash: AMEX_REFERENCE }), cardRow(), cardRow()];
    repo.importCardTransactions(cardImport(cardId, rows));
    expect(() => repo.importCardTransactions(cardImport(cardId, [cardRow({ description: 'PAID 4111111111111111' })]))).toThrow();
    expect(() => rawDb(repo).prepare('UPDATE card_accounts SET nickname = ?').run('5555555555554444')).toThrow();
    const before = {
      accounts: repo.listCardAccounts(),
      transactions: repo.listCardTransactions(),
      batches: repo.listCardImportBatches(),
    };
    const backup = path.join(dir, 'backup.db');
    // The same statement scripts/backup.sh runs.
    rawDb(repo).prepare('VACUUM INTO ?').run(backup);
    repo.close();

    const restoredFile = path.join(dir, 'restored', 'finance.db');
    await mkdir(path.dirname(restoredFile));
    await copyFile(backup, restoredFile);
    repo = new SqliteStateRepo({ file: restoredFile });
    expect(repo.schemaVersion()).toBe(15);
    expect({
      accounts: repo.listCardAccounts(),
      transactions: repo.listCardTransactions(),
      batches: repo.listCardImportBatches(),
    }).toEqual(before);
    expect(repo.importCardTransactions(cardImport(cardId, rows))).toMatchObject({ newCount: 0, duplicateCount: 3 });
    expect(() => rawDb(repo).prepare('UPDATE card_transactions SET notes = ?').run('SYNTHETIC 378282246310005'))
      .toThrow(/^card_transactions\.notes must not contain/);
    expect(() => rawDb(repo).prepare('UPDATE card_accounts SET last4 = ?').run('90003')).toThrow(/CHECK constraint failed: last4/);

    for (const file of [backup, path.join(dir, 'finance.db')]) {
      const bytes = await readFile(file);
      for (const number of TEST_CARD_NUMBERS) expect(bytes.includes(number), `${path.basename(file)} holds ${number.slice(-4)}`).toBe(false);
    }
  });
});

describe('SqliteStateRepo card secrets (v13)', () => {
  const SECRET = /must not contain a card security code, PIN or expiry date$/;
  const MERCHANTS = [
    'EXPEDIA 7284561', 'CVS PHARMACY #1234', 'PINTEREST', 'AMEX EXPRESS', 'CSC SERVICEWORKS 1234',
    'HOME SECURITY 1234', 'SPINNAKER CAFE', 'CIDER MILL', 'offer expires 12/29/2026',
    'EXP REALTY LLC 12/29', 'EXPRESS SCRIPTS 800-282-2881', 'SQ *PIN-UP NAILS 0423', 'PinPoint Pharmacy 1234',
    "MCDONALD'S F12345 06/29", '{"merchant":"EXPEDIA","amount":"12.29"}',
    'PIN, INC', 'CVS, #123', 'EXPRESS (MM) 12', 'WALGREENS #1234, BOSTON MA', 'PINTEREST (ADS) 1234',
  ];
  // The four review examples, then quoted, structured and cased variants.
  const STRUCTURED_SECRETS = [
    '{"cvv":"123","expiry":"12/29"}',
    "cvv = '123'",
    'expiry_date=12/29',
    'CVV:     123',
    "{'cvc': '4567'}",
    '"securityCode" : "1234"',
    'card-security-code=123',
    'pin_code = "9876"',
    '{"expMonth":12,"expYear":2029}',
    'validThru:          12/29',
    '"{\\"cvv\\":\\"123\\"}"',
    // Round 3: record delimiters, bracketed labels and format hints.
    'cvv, 123',
    'cvv; 123',
    '(CVV): 123',
    '[CVV] = 123',
    'Expiry (MM/YY): 12/29',
    'cvv,123,exp,12/29',
    'Security code (CVV2): 1234',
    '<cvv>123</cvv>',
    'Expiry (MM): 12',
  ];
  let cardId: string;

  beforeEach(() => {
    cardId = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD' }).id;
  });

  it('refuses a nickname with a security code or expiry, without echoing it', () => {
    for (const nickname of ['CVV 123; expiry 12/29', 'Gold cvv: 1234', 'exp 12/29', 'PIN 4321', 'ＣＶＶ １２３']) {
      expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname, currency: 'USD' }), nickname)
        .toThrow(/^nickname must not contain a card security code, PIN or expiry date$/);
    }
    expect(repo.listCardAccounts()).toHaveLength(1);
  });

  it.each([
    ['description', { description: 'AMAZON MKTP CVV 123' }],
    ['merchant', { merchant: 'Blue Bottle exp 12/29' }],
    ['issuerCategory', { issuerCategory: 'Security Code: 4321' }],
  ])('rejects the whole import for a secret in %s', (field, patch) => {
    expect(() => repo.importCardTransactions(cardImport(cardId, [cardRow(), cardRow(patch)])))
      .toThrow(new RegExp(`^rows\\[1\\]\\.${field} must not contain a card security code, PIN or expiry date$`));
    expect(repo.listCardTransactions()).toEqual([]);
    expect(repo.listCardImportBatches()).toEqual([]);
  });

  it('backs the repository up in SQL for every free-text column', () => {
    repo.importCardTransactions(cardImport(cardId, [cardRow()]));
    const [row] = repo.listCardTransactions();
    const db = rawDb(repo);
    const cases: Array<[string, string, string]> = [
      ['card_accounts', 'nickname', 'cvv 123'],
      ['card_transactions', 'description', 'VALID THRU 12/29'],
      ['card_transactions', 'merchant', 'expiry 2029-12'],
      ['card_transactions', 'issuer_category', 'C.V.V. 1234'],
      ['card_transactions', 'user_category', 'PIN: 123456'],
      ['card_transactions', 'notes', 'card 0003, security code 789, exp Dec 2029'],
      ['card_transactions', 'notes', 'cvv:\t\t\n\n   123'],
      ['card_accounts', 'nickname', '{\n  "expiry":\t"12/29"\n}'],
      ['card_transactions', 'notes', 'cvv\t123'],
      ['card_accounts', 'nickname', 'name;J DOE\npin;4321'],
    ];
    for (const [table, column, value] of cases) {
      const id = table === 'card_accounts' ? cardId : row.id;
      expect(() => db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id), `${table}.${column}`)
        .toThrow(new RegExp(`^${table}\\.${column} ${SECRET.source}`));
    }
    expect(repo.listCardTransactions()).toEqual([row]);
  });

  it.each(STRUCTURED_SECRETS)('refuses %j through the repository and through SQL INSERT and UPDATE', (secret) => {
    const problem = 'must not contain a card security code, PIN or expiry date';
    expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: secret, currency: 'USD' }))
      .toThrow(new RegExp(`^nickname ${problem}$`));
    expect(() => repo.importCardTransactions(cardImport(cardId, [cardRow(), cardRow({ merchant: secret })])))
      .toThrow(new RegExp(`^rows\\[1\\]\\.merchant ${problem}$`));

    repo.importCardTransactions(cardImport(cardId, [cardRow()]));
    const db = rawDb(repo);
    const stored = db.prepare('SELECT * FROM card_transactions').get() as Record<string, unknown>;
    expect(() => insertRow(db, 'card_accounts', {
      id: 'card-acct-raw', issuer: 'amex', owner: 'alex', nickname: secret, currency: 'USD',
    })).toThrow(new RegExp(`^card_accounts\\.nickname ${problem}$`));
    expect(() => insertRow(db, 'card_transactions', { ...stored, id: 'card-txn-raw', description: secret }))
      .toThrow(new RegExp(`^card_transactions\\.description ${problem}$`));
    expect(() => db.prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run(secret, cardId))
      .toThrow(new RegExp(`^card_accounts\\.nickname ${problem}$`));
    expect(() => db.prepare('UPDATE card_transactions SET notes = ? WHERE id = ?').run(secret, stored.id))
      .toThrow(new RegExp(`^card_transactions\\.notes ${problem}$`));

    expect(repo.listCardAccounts().map((card) => card.nickname)).toEqual([undefined]);
    expect(repo.listCardTransactions().map((row) => row.notes)).toEqual([undefined]);
  });

  it('accepts ordinary merchant text that only resembles a label', () => {
    for (const merchant of MERCHANTS) {
      expect(repo.importCardTransactions(cardImport(cardId, [cardRow({ merchant, description: merchant })])).newCount, merchant)
        .toBe(1);
    }
    expect(repo.listCardTransactions().map((row) => row.merchant)).toEqual(MERCHANTS);
    const [row] = repo.listCardTransactions();
    const update = rawDb(repo).prepare('UPDATE card_transactions SET notes = ?, revision = revision + 1 WHERE id = ?');
    for (const merchant of MERCHANTS) update.run(merchant, row.id);
  });
});

describe('SqliteStateRepo databases from newer builds', () => {
  function snapshot(file: string) {
    const db = new Database(file);
    try {
      return {
        version: db.pragma('user_version', { simple: true }),
        cookie: db.pragma('schema_version', { simple: true }),
        schema: schemaObjects(db),
        rows: dumpTables(db, () => true),
      };
    } finally {
      db.close();
    }
  }

  function seedAndClose(): string {
    const file = path.join(dir, 'finance.db');
    seedBrokerage(repo);
    const card = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' });
    repo.importCardTransactions(cardImport(card.id, [cardRow(), cardRow({ externalIdHash: AMEX_REFERENCE })]));
    repo.close();
    return file;
  }

  function expectRefusedUnchanged(file: string, expected: RegExp, cardGuards?: CardGuardBuild): void {
    const before = snapshot(file);
    const close = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => new SqliteStateRepo({ file, cardGuards })).toThrow(expected);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    expect(snapshot(file)).toEqual(before);
    repo = new SqliteStateRepo({ file: path.join(dir, 'unrelated.db') });
  }

  it('refuses a newer schema version before any migration or guard refresh', () => {
    const file = seedAndClose();
    // What a v16 build might leave behind: a new table, a removed one, newer guards.
    const future = new Database(file);
    future.exec(`
      CREATE TABLE card_future_links (id TEXT PRIMARY KEY);
      DROP TABLE manual_prices;
      DROP TRIGGER trg_card_accounts_guard_update;
      CREATE TRIGGER trg_card_accounts_guard_update BEFORE UPDATE ON card_accounts
      BEGIN SELECT RAISE(ABORT, 'card accounts are read-only in v16'); END;
      PRAGMA user_version = 16;
    `);
    future.close();
    expectRefusedUnchanged(file, /^database schema v16 is newer than this build supports \(v15\); refusing to open it\./);
  });

  it('refuses guards stamped with a newer revision instead of replacing them', () => {
    const file = seedAndClose();
    const future = new Database(file);
    const current = future.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_card_transactions_guard_insert'")
      .get() as { sql: string };
    expect(current.sql).toContain(revisionLine(GUARD_REVISION));
    future.exec('DROP TRIGGER trg_card_transactions_guard_insert');
    future.exec(current.sql.replace(revisionLine(GUARD_REVISION), revisionLine(NEWER_REVISION)));
    future.close();
    expectRefusedUnchanged(file, new RegExp(
      `^card guards are revision ${NEWER_REVISION}, newer than this build's ${GUARD_REVISION}; refusing to open the database\\.`,
    ));
  });

  it('stamps every guard with the current revision and replaces older ones', () => {
    const db = rawDb(repo);
    const guards = db.prepare(`SELECT name, sql FROM sqlite_master WHERE ${GUARD_TRIGGERS}`).all() as Array<{ name: string; sql: string }>;
    expect(guards).toHaveLength(2 * CARD_TABLES.length);
    for (const guard of guards) expect(guard.sql, guard.name).toContain(revisionLine(GUARD_REVISION));
    const file = path.join(dir, 'finance.db');
    repo.close();
    const old = new Database(file);
    old.exec(`
      DROP TRIGGER trg_card_accounts_guard_insert;
      CREATE TRIGGER trg_card_accounts_guard_insert BEFORE INSERT ON card_accounts
      -- holdr card guard revision 0
      BEGIN SELECT 1; END;
    `);
    old.close();
    repo = new SqliteStateRepo({ file });
    const refreshed = rawDb(repo).prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_card_accounts_guard_insert'")
      .get() as { sql: string };
    expect(refreshed.sql).toContain(revisionLine(GUARD_REVISION));
    expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'CVV 123', currency: 'USD' })).toThrow();
    expect(() => insertRow(rawDb(repo), 'card_accounts', {
      id: 'card-acct-raw', issuer: 'amex', owner: 'alex', nickname: Buffer.from(PAN), currency: 'USD',
    })).toThrow(/^card_accounts\.nickname must be stored as text$/);
  });

  // The guard identity 7e66b89 to f9273c8 shipped: revision 1 with unversioned
  // detector names. Its detectors do not matter here, so it reuses this build's.
  const REVISION_1_BUILD: CardGuardBuild = {
    revision: 1, cardDataFunction: 'holdr_card_number', cardSecretFunction: 'holdr_card_secret',
    detectors: CARD_GUARD_BUILD.detectors,
  };
  const guardSql = (db: RawDb) => (db.prepare(`SELECT sql FROM sqlite_master WHERE ${GUARD_TRIGGERS}`)
    .all() as Array<{ sql: string }>).map((row) => row.sql);
  const JSON_SECRET = '{"cvv":"123","expiry":"12/29"}';

  // The columns v14 (Phase 4) and v15 (card sync) added to v13's tables.
  // Every build simulated below wrote v13 card tables without them; asV13
  // turns what this build writes back into such a database
  // (testing/cardSchemaDowngrade.ts, shared with the card-sync tests).
  const V14_COLUMNS = CARD_V14_COLUMNS;
  const V15_COLUMNS = CARD_V15_COLUMNS;
  const V13_TABLES = CARD_V13_TABLES;
  const withoutChecks = withoutGuardChecks;
  /** A guard as the same build installs it on v13 tables: without the checks on v14's and v15's columns. */
  const withoutLaterChecks = withoutChecks([...V14_COLUMNS, ...V15_COLUMNS]);
  /** The guards of v13's three tables only. */
  const v13GuardSql = (db: RawDb) => guardSql(db).filter((sql) => V13_TABLES.some((table) => sql.startsWith(`CREATE TRIGGER trg_${table}_guard_`)));
  const downgrade = downgradeCardSchema;
  const asV13 = (file: string) => downgrade(file, 13);

  it('versions the detectors it calls and is past revision 1', () => {
    expect(GUARD_REVISION).toBeGreaterThan(REVISION_1_BUILD.revision);
    for (const name of [CARD_GUARD_BUILD.cardDataFunction, CARD_GUARD_BUILD.cardSecretFunction]) {
      expect(name).toMatch(new RegExp(`_v${GUARD_REVISION}$`));
    }
    for (const sql of guardSql(rawDb(repo))) {
      expect(sql).toContain(`${CARD_GUARD_BUILD.cardDataFunction}(NEW.`);
      expect(sql).toContain(`${CARD_GUARD_BUILD.cardSecretFunction}(NEW.`);
      expect(sql).not.toMatch(/holdr_card_(number|secret)\(/);
    }
  });

  it('an older build refuses a database that needs the stronger detectors, and changes nothing', () => {
    const file = seedAndClose();
    const cardId = (() => {
      const db = new Database(file);
      try {
        return (db.prepare('SELECT id FROM card_accounts').get() as { id: string }).id;
      } finally {
        db.close();
      }
    })();
    expectRefusedUnchanged(file, new RegExp(
      `^card guards are revision ${GUARD_REVISION}, newer than this build's 1; refusing to open the database\\.`,
    ), REVISION_1_BUILD);

    // A build from before revisions existed does not refuse, but it cannot
    // write card rows either: the triggers call detectors it never registers.
    const before = snapshot(file);
    const legacy = new Database(file);
    try {
      legacy.function('holdr_card_number', () => 0);
      legacy.function('holdr_card_secret', () => 0);
      expect(() => legacy.prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run(JSON_SECRET, cardId))
        .toThrow(new RegExp(`no such function: (${CARD_GUARD_BUILD.cardDataFunction}|${CARD_GUARD_BUILD.cardSecretFunction})`));
    } finally {
      legacy.close();
    }
    expect(snapshot(file)).toEqual(before);
  });

  it('upgrades the guards an older build wrote, after which that build is refused', () => {
    const file = path.join(dir, 'older.db');
    const older = new SqliteStateRepo({ file, cardGuards: REVISION_1_BUILD });
    older.createCardAccount({ issuer: 'amex', owner: 'alex', currency: 'USD' });
    for (const sql of guardSql(older.internalGetDb())) {
      expect(sql).toContain(revisionLine(1));
      expect(sql).toContain('holdr_card_secret(NEW.');
    }
    older.close();

    const current = new SqliteStateRepo({ file });
    for (const sql of guardSql(current.internalGetDb())) {
      expect(sql).toContain(revisionLine(GUARD_REVISION));
      expect(sql).not.toMatch(/holdr_card_(number|secret)\(/);
    }
    expect(() => current.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: JSON_SECRET, currency: 'USD' }))
      .toThrow(/^nickname must not contain a card security code, PIN or expiry date$/);
    current.close();
    expect(() => new SqliteStateRepo({ file, cardGuards: REVISION_1_BUILD }))
      .toThrow(new RegExp(`^card guards are revision ${GUARD_REVISION}, newer than this build's 1`));
  });

  // Exactly the guard identity a075553 shipped: revision 2, the v2 names, and
  // Phase 1's card number detector from before 06e694d, vendored verbatim.
  // Nothing else card writes depend on has changed since a075553. b9c66dd
  // shipped the stronger detector under this same identity.
  const A075553_BUILD: CardGuardBuild = {
    revision: 2,
    cardDataFunction: 'holdr_card_data_v2',
    cardSecretFunction: 'holdr_card_secret_v2',
    detectors: { containsCardData: a075553ContainsCardData, containsCardSecret },
  };
  // Published test numbers in dot-separated groups: 06e694d's detector
  // catches them, a075553's misses them.
  const DOTTED_PANS = ['4111.1111.1111.1111', '5555.5555.5555.4444'];
  const A075553_REFUSED = new RegExp(
    `^card guards are revision ${GUARD_REVISION}, newer than this build's 2; refusing to open the database\\.`,
  );

  it('simulates a075553 exactly: its own database takes dotted card numbers this build rejects', () => {
    for (const pan of DOTTED_PANS) {
      expect(A075553_BUILD.detectors.containsCardData(pan), pan).toBe(false);
      expect(CARD_GUARD_BUILD.detectors.containsCardData(pan), pan).toBe(true);
    }
    const old = new SqliteStateRepo({ file: path.join(dir, 'a075553.db'), cardGuards: A075553_BUILD });
    try {
      for (const sql of guardSql(old.internalGetDb())) {
        expect(sql).toContain(revisionLine(2));
        expect(sql).toContain('holdr_card_data_v2(NEW.');
      }
      const card = old.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[0], currency: 'USD' });
      expect(old.getCardAccount(card.id)?.nickname).toBe(DOTTED_PANS[0]);
      old.internalGetDb().prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run(DOTTED_PANS[1], card.id);
      expect(old.getCardAccount(card.id)?.nickname).toBe(DOTTED_PANS[1]);
    } finally {
      old.close();
    }

    expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[0], currency: 'USD' }))
      .toThrow(/^nickname must not contain a card number/);
    expect(() => insertRow(rawDb(repo), 'card_accounts', {
      id: 'card-acct-raw', issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[1], currency: 'USD',
    })).toThrow(/^card_accounts\.nickname must not contain a card number$/);
  });

  it('a075553 refuses a database this build wrote, and changes nothing', () => {
    expect(GUARD_REVISION).toBeGreaterThan(A075553_BUILD.revision);
    expect([CARD_GUARD_BUILD.cardDataFunction, CARD_GUARD_BUILD.cardSecretFunction])
      .not.toContain(A075553_BUILD.cardDataFunction);
    expect([CARD_GUARD_BUILD.cardDataFunction, CARD_GUARD_BUILD.cardSecretFunction])
      .not.toContain(A075553_BUILD.cardSecretFunction);
    const file = seedAndClose();
    expectRefusedUnchanged(file, A075553_REFUSED, A075553_BUILD);

    // Nor can a raw connection with a075553's detectors write card rows: the
    // guards call this build's names.
    const before = snapshot(file);
    const old = new Database(file);
    try {
      old.function(A075553_BUILD.cardDataFunction, (value: unknown) =>
        (typeof value === 'string' && A075553_BUILD.detectors.containsCardData(value) ? 1 : 0));
      old.function(A075553_BUILD.cardSecretFunction, (value: unknown) =>
        (typeof value === 'string' && A075553_BUILD.detectors.containsCardSecret(value) ? 1 : 0));
      const missing = new RegExp(
        `^no such function: (${CARD_GUARD_BUILD.cardDataFunction}|${CARD_GUARD_BUILD.cardSecretFunction})$`,
      );
      const { id } = old.prepare('SELECT id FROM card_accounts').get() as { id: string };
      expect(() => old.prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run(DOTTED_PANS[0], id))
        .toThrow(missing);
      expect(() => insertRow(old, 'card_accounts', {
        id: 'card-acct-raw', issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[1], currency: 'USD',
      })).toThrow(missing);
    } finally {
      old.close();
    }
    expect(snapshot(file)).toEqual(before);
  });

  it('upgrades a database a075553 wrote, after which a075553 is refused', () => {
    repo.close();
    const file = path.join(dir, 'a075553.db');
    const old = new SqliteStateRepo({ file, cardGuards: A075553_BUILD });
    old.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '1111', currency: 'USD' });
    old.close();

    const current = new SqliteStateRepo({ file });
    for (const sql of guardSql(current.internalGetDb())) {
      expect(sql).toContain(revisionLine(GUARD_REVISION));
      expect(sql).toContain(`${CARD_GUARD_BUILD.cardDataFunction}(NEW.`);
      expect(sql).not.toContain('_v2(');
    }
    expect(() => current.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[0], currency: 'USD' }))
      .toThrow(/^nickname must not contain a card number/);
    current.close();
    expectRefusedUnchanged(file, A075553_REFUSED, A075553_BUILD);
  });

  it('refuses an a075553 database whose rows fail the new detectors, byte for byte unchanged, until they are fixed', () => {
    const file = path.join(dir, 'a075553.db');
    const old = new SqliteStateRepo({ file, cardGuards: A075553_BUILD });
    const card = old.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[0], currency: 'USD' });
    old.importCardTransactions(cardImport(card.id, [cardRow(), cardRow({ description: DOTTED_PANS[1] })]));
    const txn = old.listCardTransactions().find((row) => row.description === DOTTED_PANS[1])!;
    old.close();
    asV13(file);

    // The v14 and v15 upgrades run first, inside the same transaction; the
    // re-check then refuses, and nothing of either remains.
    expectRefusedByteIdentical(file, storedRowsRefusal([
      `card_accounts.nickname in row ${card.id}`,
      `card_transactions.description in row ${txn.id}`,
    ]), DOTTED_PANS);

    // The refusal left a075553's v13 database and guards in place, so
    // a075553 can still fix or delete the rows, after which this build
    // upgrades the database.
    const fixer = new Database(file);
    fixer.function(A075553_BUILD.cardDataFunction, (value: unknown) =>
      (typeof value === 'string' && A075553_BUILD.detectors.containsCardData(value) ? 1 : 0));
    fixer.function(A075553_BUILD.cardSecretFunction, (value: unknown) =>
      (typeof value === 'string' && A075553_BUILD.detectors.containsCardSecret(value) ? 1 : 0));
    fixer.prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run('Blue Cash', card.id);
    fixer.prepare('DELETE FROM card_transactions WHERE id = ?').run(txn.id);
    fixer.close();
    const fixed = new SqliteStateRepo({ file });
    try {
      expect(fixed.getCardAccount(card.id)?.nickname).toBe('Blue Cash');
      expect(fixed.listCardTransactions().map((row) => row.description)).toEqual(['BLUE BOTTLE COFFEE']);
      for (const sql of guardSql(fixed.internalGetDb())) expect(sql).toContain(revisionLine(GUARD_REVISION));
    } finally {
      fixed.close();
    }
  });

  it('upgrades a clean a075553 database after checking its rows, keeping every row', () => {
    const file = path.join(dir, 'a075553.db');
    const old = new SqliteStateRepo({ file, cardGuards: A075553_BUILD });
    seedBrokerage(old);
    const card = old.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', currency: 'USD' });
    old.importCardTransactions(cardImport(card.id, [cardRow(), cardRow(), cardRow({ externalIdHash: AMEX_REFERENCE })]));
    const rows = dumpTables(old.internalGetDb(), () => true);
    old.close();

    const current = new SqliteStateRepo({ file });
    try {
      const db = rawDb(current);
      expect(dumpTables(db, () => true)).toEqual(rows);
      for (const sql of guardSql(db)) expect(sql).toContain(`${revisionLine(GUARD_REVISION)}${ROWS_CHECKED_LINE}\n`);
      expect(() => current.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[0], currency: 'USD' }))
        .toThrow(/^nickname must not contain a card number/);
    } finally {
      current.close();
    }
  });

  // Exactly the guard identity 9eac1b2 to 1f1ffbf shipped: revision 3, the v3
  // names, and Phase 1's card number detector as of 06e694d, vendored
  // verbatim. Their other card code is this build's, so with it this build
  // writes 1f1ffbf's guards byte for byte. 9eac1b2 installed the same checks
  // without re-checking stored rows, so its guards also lack the second
  // comment line and the ASCII pre-check. The tripwire pinned both.
  const REVISION_3_BUILD: CardGuardBuild = {
    revision: 3,
    cardDataFunction: 'holdr_card_data_v3',
    cardSecretFunction: 'holdr_card_secret_v3',
    detectors: { containsCardData: revision3ContainsCardData, containsCardSecret },
  };
  const GUARD_SQL_1F1FFBF = '7bb1e7edb81b9f450bc3cc379b95bf498b11e1e68ed7651207bc6cfb21bd2473';
  const GUARD_SQL_9EAC1B2 = 'fd629186ad0067026a8ebb86328f1930c12ee355639a182cc52a39482e4a22f1';
  const as9eac1b2 = (sql: string) => sql
    .replace(`\n${ROWS_CHECKED_LINE}`, '')
    .replace(/NEW\."\w+" GLOB '\*\[\^ -~\]\*' AND /g, '');
  // Card data only the span-based detector catches: a masked Maestro number
  // showing its first four digits as well as its last four, and a test card
  // number missing its last digit.
  const REVISION_4_ONLY = ['5018 ****0009', 'INV 4111 1111 1111 111'];
  const REVISION_3_REFUSED = new RegExp(
    `^card guards are revision ${GUARD_REVISION}, newer than this build's 3; refusing to open the database\\.`,
  );

  /** A database revision 3 wrote: 1f1ffbf's guards as they are, or 9eac1b2's in their place, on v13 tables. */
  function revision3Database(build: '1f1ffbf' | '9eac1b2', write: (old: SqliteStateRepo) => void): string {
    const file = path.join(dir, `${build}.db`);
    const old = new SqliteStateRepo({ file, cardGuards: REVISION_3_BUILD });
    write(old);
    old.close();
    asV13(file);
    if (build === '9eac1b2') {
      const db = new Database(file);
      for (const sql of guardSql(db)) {
        db.exec(`DROP TRIGGER ${/^CREATE TRIGGER (\w+)/.exec(sql)![1]}`);
        db.exec(as9eac1b2(sql));
      }
      db.close();
    }
    return file;
  }

  it('simulates 9eac1b2 and 1f1ffbf exactly: their guards byte for byte, and values only revision 4 refuses', () => {
    for (const text of REVISION_4_ONLY) {
      expect(REVISION_3_BUILD.detectors.containsCardData(text), text).toBe(false);
      expect(CARD_GUARD_BUILD.detectors.containsCardData(text), text).toBe(true);
    }
    let cardId = '';
    const file = revision3Database('1f1ffbf', (old) => {
      cardId = old.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: REVISION_4_ONLY[0], currency: 'USD' }).id;
      old.internalGetDb().prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run(REVISION_4_ONLY[1], cardId);
      expect(old.getCardAccount(cardId)?.nickname).toBe(REVISION_4_ONLY[1]);
    });
    const db = new Database(file, { readonly: true });
    try {
      const sql = guardSql(db);
      expect(sha256([...sql].sort().join('\n'))).toBe(GUARD_SQL_1F1FFBF);
      expect(sha256(sql.map(as9eac1b2).sort().join('\n'))).toBe(GUARD_SQL_9EAC1B2);
    } finally {
      db.close();
    }

    expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: REVISION_4_ONLY[0], currency: 'USD' }))
      .toThrow(/^nickname must not contain a card number/);
    expect(() => insertRow(rawDb(repo), 'card_accounts', {
      id: 'card-acct-raw', issuer: 'amex', owner: 'alex', nickname: REVISION_4_ONLY[1], currency: 'USD',
    })).toThrow(/^card_accounts\.nickname must not contain a card number$/);
  });

  it('revision 3 builds (9eac1b2 to 1f1ffbf) refuse a database this build wrote, and change nothing', () => {
    expect(GUARD_REVISION).toBeGreaterThan(REVISION_3_BUILD.revision);
    const names = [CARD_GUARD_BUILD.cardDataFunction, CARD_GUARD_BUILD.cardSecretFunction];
    expect(names).not.toContain(REVISION_3_BUILD.cardDataFunction);
    expect(names).not.toContain(REVISION_3_BUILD.cardSecretFunction);
    const file = seedAndClose();
    expectRefusedUnchanged(file, REVISION_3_REFUSED, REVISION_3_BUILD);

    // Nor can a raw connection with the revision 3 detectors write card rows.
    const before = snapshot(file);
    const old = new Database(file);
    try {
      old.function(REVISION_3_BUILD.cardDataFunction, (value: unknown) =>
        (typeof value === 'string' && REVISION_3_BUILD.detectors.containsCardData(value) ? 1 : 0));
      old.function(REVISION_3_BUILD.cardSecretFunction, (value: unknown) =>
        (typeof value === 'string' && REVISION_3_BUILD.detectors.containsCardSecret(value) ? 1 : 0));
      const missing = new RegExp(`^no such function: (${names.join('|')})$`);
      const { id } = old.prepare('SELECT id FROM card_accounts').get() as { id: string };
      expect(() => old.prepare('UPDATE card_accounts SET nickname = ? WHERE id = ?').run(REVISION_4_ONLY[0], id))
        .toThrow(missing);
      expect(() => insertRow(old, 'card_accounts', {
        id: 'card-acct-raw', issuer: 'amex', owner: 'alex', nickname: REVISION_4_ONLY[1], currency: 'USD',
      })).toThrow(missing);
    } finally {
      old.close();
    }
    expect(snapshot(file)).toEqual(before);
  });

  it.each(['1f1ffbf', '9eac1b2'] as const)(
    'refuses to upgrade a %s database holding values only the span-based detector catches, byte for byte unchanged',
    (build) => {
      let card = '';
      let txn = '';
      const file = revision3Database(build, (old) => {
        card = old.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: REVISION_4_ONLY[0], currency: 'USD' }).id;
        old.importCardTransactions(cardImport(card, [cardRow(), cardRow({ description: REVISION_4_ONLY[1] })]));
        txn = old.listCardTransactions().find((row) => row.description === REVISION_4_ONLY[1])!.id;
      });
      expectRefusedByteIdentical(file, storedRowsRefusal([
        `card_accounts.nickname in row ${card}`,
        `card_transactions.description in row ${txn}`,
      ]), REVISION_4_ONLY);
    },
  );

  it('upgrades a clean revision 3 database after checking its rows, after which revision 3 is refused', () => {
    repo.close();
    let rows: Record<string, unknown[]> = {};
    const file = revision3Database('1f1ffbf', (old) => {
      seedBrokerage(old);
      const card = old.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', currency: 'USD' });
      old.importCardTransactions(cardImport(card.id, [cardRow(), cardRow(), cardRow({ externalIdHash: AMEX_REFERENCE })]));
      rows = dumpTables(old.internalGetDb(), () => true);
    });

    const current = new SqliteStateRepo({ file });
    try {
      const db = rawDb(current);
      // Every row revision 3 kept in its v13 database, as it kept it.
      expect(asV13Rows(dumpTables(db, () => true))).toEqual(asV13Rows(rows));
      for (const sql of guardSql(db)) {
        expect(sql).toContain(`${revisionLine(GUARD_REVISION)}${ROWS_CHECKED_LINE}\n`);
        expect(sql).toContain(`${CARD_GUARD_BUILD.cardDataFunction}(NEW.`);
        expect(sql).not.toContain('_v3(');
      }
    } finally {
      current.close();
    }
    expectRefusedUnchanged(file, REVISION_3_REFUSED, REVISION_3_BUILD);
  });

  it('re-checks the rows of a database 9eac1b2 upgraded without checking them', () => {
    const file = path.join(dir, 'a075553.db');
    const old = new SqliteStateRepo({ file, cardGuards: A075553_BUILD });
    const card = old.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: DOTTED_PANS[0], currency: 'USD' });
    old.close();
    asV13(file);
    // What 9eac1b2 did on open: its revision 3 guards, installed without
    // looking at the rows.
    const db = new Database(file);
    for (const sql of guardSql(db)) db.exec(`DROP TRIGGER ${/^CREATE TRIGGER (\w+)/.exec(sql)![1]}`);
    const revision3 = new Database(revision3Database('1f1ffbf', () => {}), { readonly: true });
    for (const sql of guardSql(revision3)) db.exec(as9eac1b2(sql));
    revision3.close();
    expect(sha256(guardSql(db).sort().join('\n'))).toBe(GUARD_SQL_9EAC1B2);
    db.close();

    expectRefusedByteIdentical(file, storedRowsRefusal([`card_accounts.nickname in row ${card.id}`]), DOTTED_PANS);
  });

  // Phase 3's guards on its v13 tables (78b291d): revision 4 and the v4 names,
  // as the tripwire below pinned them before v14 added columns.
  const GUARD_SQL_78B291D = 'f77490218e2f5b85674b302ce9e2d70d37391ca0c3e7389e17dcb3fbbd13b116';
  // A v13 text column of each table, whose checks a v14 column must share.
  const V13_PEER: Record<string, string> = { card_accounts: 'nickname', card_import_batches: 'source', card_transactions: 'notes' };
  const branches = (sql: string, column: string) => sql.split('\n').filter((line) => line.includes(`NEW."${column}"`));
  /** The upgraded database as v13 saw it: v13's tables and columns only (every other table is v15's or brokerage's own). */
  const asV13Rows = (dump: Record<string, unknown[]>) => Object.fromEntries(Object.entries(dump)
    .filter(([table]) => !table.startsWith('card_') || V13_TABLES.includes(table))
    .map(([table, rows]) => [
      table,
      (rows as Array<Record<string, unknown>>).map((row) => Object.fromEntries(Object.entries(row)
        .filter(([column]) => ![...V14_COLUMNS, ...V15_COLUMNS].some(([t, name]) => t === table && name === column)))),
    ]));

  /** A v13 database as Phase 3 (78b291d) leaves it: brokerage rows, a card, an import and three card rows, one pending. */
  function phase3Database(): { file: string; txn: string; pending: string } {
    const file = path.join(dir, 'phase3.db');
    const old = new SqliteStateRepo({ file });
    seedBrokerage(old);
    const card = old.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', currency: 'USD' });
    old.importCardTransactions(cardImport(card.id, [
      cardRow(), cardRow({ externalIdHash: AMEX_REFERENCE }), cardRow({ status: 'pending', postedDate: null, amountMinor: 777 }),
    ]));
    const [txn] = old.listCardTransactions();
    const pending = old.listCardTransactions().find((row) => row.status === 'pending')!;
    old.close();
    asV13(file);
    return { file, txn: txn.id, pending: pending.id };
  }

  it('upgrades a v13 database Phase 3 guarded at revision 4, guarding the v14 and v15 columns like the rest', () => {
    const { file } = phase3Database();
    const v13 = new Database(file, { readonly: true });
    let before: string[] = [];
    let rows: Record<string, unknown[]> = {};
    try {
      expect(v13.pragma('user_version', { simple: true })).toBe(13);
      before = guardSql(v13);
      expect(sha256([...before].sort().join('\n'))).toBe(GUARD_SQL_78B291D);
      rows = dumpTables(v13, () => true);
    } finally {
      v13.close();
    }

    const current = new SqliteStateRepo({ file });
    try {
      const db = rawDb(current);
      expect(db.pragma('user_version', { simple: true })).toBe(15);
      const upgraded = dumpTables(db, () => true);
      expect(asV13Rows(upgraded)).toEqual(rows);
      for (const [table, column] of V14_COLUMNS) {
        for (const row of upgraded[table] as Array<Record<string, unknown>>) expect(row[column], `${table}.${column}`).toBeNull();
      }

      // Revision 4 throughout, v13's checks byte for byte, on each v14 and v15
      // column every check its type gets (a text column's those of its table's
      // text columns), under its own name; and every v15 table guarded.
      const after = v13GuardSql(db);
      expect(after).toHaveLength(6);
      expect(guardSql(db)).toHaveLength(2 * CARD_TABLES.length);
      for (const sql of guardSql(db)) expect(sql).toContain(revisionLine(GUARD_REVISION));
      expect(after.map(withoutLaterChecks).sort()).toEqual([...before].sort());
      for (const [table, column] of [...V14_COLUMNS, ...V15_COLUMNS]) {
        const type = CARD_SCHEMA[table].columns.get(column);
        for (const event of ['insert', 'update']) {
          const sql = after.find((text) => text.startsWith(`CREATE TRIGGER trg_${table}_guard_${event}\n`))!;
          expect(branches(sql, column).length, `${table}.${column} ${event}`).toBe(type === 'TEXT' ? 6 : 2);
          if (type === 'TEXT') {
            expect(branches(sql, column).map((line) => line.replaceAll(column, V13_PEER[table])), `${table}.${column} ${event}`)
              .toEqual(branches(sql, V13_PEER[table]));
          }
        }
      }

      // Card data written straight into a new column is refused, naming only the column.
      const [card] = current.listCardAccounts();
      const [batch] = current.listCardImportBatches();
      const [txn] = current.listCardTransactions();
      const spaced = PAN.replace(/(\d{4})(?=\d)/g, '$1 ');
      for (const [column, sql, id] of [
        ['card_accounts.last5', 'UPDATE card_accounts SET last5 = ? WHERE id = ?', card.id],
        ['card_import_batches.coverage_start',
          "UPDATE card_import_batches SET coverage_start = ?, coverage_end = '2026-10-31' WHERE id = ?", batch.id],
        ['card_import_batches.coverage_end',
          "UPDATE card_import_batches SET coverage_start = '2026-10-01', coverage_end = ? WHERE id = ?", batch.id],
        ['card_transactions.dismissed_at', "UPDATE card_transactions SET status = 'removed', dismissed_at = ? WHERE id = ?", txn.id],
      ] as const) {
        for (const [value, problem] of [
          [Buffer.from(spaced), 'must be stored as text'],
          [ARABIC_INDIC_PAN, 'must not contain non-ASCII digits or invisible characters'],
          [PAN, 'must not contain 13 or more consecutive digits'],
          [spaced, 'must not contain a card number'],
          [`paid ${spaced}`, 'must not contain a card number'],
          ['CVV 123 exp 12/29 at 2026-10-16', 'must not contain a card security code, PIN or expiry date'],
        ] as const) {
          let message = '';
          try {
            db.prepare(sql).run(value, id);
          } catch (error) {
            message = (error as Error).message;
          }
          expect(message, `${column}: ${String(value)}`).toBe(`${column} ${problem}`);
        }
      }
      expect(dumpTables(db, () => true)).toEqual(upgraded);
    } finally {
      current.close();
    }
  });

  it('re-checks the v14 columns with the rest when it replaces guards', () => {
    const { file, pending } = phase3Database();
    new SqliteStateRepo({ file }).close();
    // An outside tool drops the guards and stores a card number where only v14
    // has a column, in a dismissal the v15 ledger rules otherwise accept.
    const planted = `paid ${PAN.replace(/(\d{4})(?=\d)/g, '$1 ')}`;
    const db = new Database(file);
    try {
      for (const table of CARD_TABLES) db.exec(`DROP TRIGGER trg_${table}_guard_insert; DROP TRIGGER trg_${table}_guard_update`);
      db.prepare(`UPDATE card_transactions SET status = 'removed', removed_reason = 'dismissed', removed_from_status = 'pending',
          removed_at = '2026-10-16T12:00:00.000Z', dismissed_at = ?, revision = revision + 1 WHERE id = ?`).run(planted, pending);
    } finally {
      db.close();
    }
    expectRefusedByteIdentical(file, storedRowsRefusal([`card_transactions.dismissed_at in row ${pending}`]), [planted, PAN]);
  });

  it('checks each distinct stored value once when it replaces guards, and none when they are current', () => {
    const file = path.join(dir, 'a075553.db');
    const old = new SqliteStateRepo({ file, cardGuards: A075553_BUILD });
    const card = old.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', currency: 'USD' });
    old.importCardTransactions(cardImport(card.id, [
      cardRow(), cardRow(), cardRow({ externalIdHash: AMEX_REFERENCE, merchant: undefined }),
    ]));
    const db = old.internalGetDb();
    // Every card table's text, v15's included (its registries, the legacy
    // scope, identities, contents, events, the policy and audit rows). A
    // guard function remembers the short texts it found clean, so each
    // distinct one reaches the detectors once.
    const distinct = new Set<string>();
    for (const table of CARD_TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
      for (const { name } of columns.filter((column) => column.type === 'TEXT')) {
        for (const value of db.prepare(`SELECT ${name} FROM ${table} WHERE ${name} IS NOT NULL`).pluck().all() as string[]) {
          expect(value.length).toBeLessThanOrEqual(256);
          distinct.add(value);
        }
      }
    }
    old.close();
    const textValues = distinct.size;
    expect(textValues).toBeGreaterThan(40);

    const calls = { data: 0, secret: 0 };
    const counted: CardGuardBuild = {
      ...CARD_GUARD_BUILD,
      detectors: {
        containsCardData: (text) => { calls.data += 1; return containsCardData(text); },
        containsCardSecret: (text) => { calls.secret += 1; return containsCardSecret(text); },
      },
    };
    new SqliteStateRepo({ file, cardGuards: counted }).close();
    expect(calls).toEqual({ data: textValues, secret: textValues });
    calls.data = 0;
    calls.secret = 0;
    new SqliteStateRepo({ file, cardGuards: counted }).close();
    expect(calls).toEqual({ data: 0, secret: 0 });
  });

  it('remembers only short texts its detectors found clean, so card data is detected on every call (r1 finding 2)', () => {
    const seen: string[] = [];
    const counted: CardGuardBuild = {
      ...CARD_GUARD_BUILD,
      detectors: {
        containsCardData: (text) => { seen.push(text); return containsCardData(text); },
        containsCardSecret,
      },
    };
    const repo = new SqliteStateRepo({ file: ':memory:', cardGuards: counted });
    try {
      const check = repo.internalGetDb().prepare(`SELECT ${CARD_GUARD_BUILD.cardDataFunction}(?)`).pluck();
      seen.length = 0;
      const card = `paid ${['4111', '1111', '1111', '1111'].join(' ')}`;
      const long = `SYNTHETIC ${'MERCHANT '.repeat(40)}`;
      expect(long.length).toBeGreaterThan(256);
      expect(['SYNTHETIC CAFE', 'SYNTHETIC CAFE', card, card, long, long, null, 42].map((value) => check.get(value)))
        .toEqual([0, 0, 1, 1, 0, 0, 0, 0]);
      // The clean short text reaches the detector once; card data and long text every time; non-text never.
      expect(seen).toEqual(['SYNTHETIC CAFE', card, card, long, long]);
      // At most 4,096 are remembered, the oldest forgotten first.
      seen.length = 0;
      for (let i = 0; i <= 4096; i += 1) check.get(`clean text ${i}`);
      check.get('clean text 4096');
      check.get('clean text 0');
      expect(seen.length).toBe(4097 + 1);
      expect(seen.at(-1)).toBe('clean text 0');
    } finally {
      repo.close();
    }
  });

  it('never remembers a text either detector refuses, whichever is asked first (r2 finding 1)', () => {
    // Synthetic values only: a CVV/expiry JSON the number detector finds clean, and a test PAN the secret detector finds clean.
    const secret = '{"cvv":"123","expiry":"12/29"}';
    const pan = ['4111', '1111', '1111', '1111'].join(' ');
    expect([containsCardData(secret), containsCardSecret(secret)]).toEqual([false, true]);
    expect([containsCardData(pan), containsCardSecret(pan)]).toEqual([true, false]);
    const watched = new Set([secret, pan]);
    const calls = { data: 0, secret: 0 };
    const counted: CardGuardBuild = {
      ...CARD_GUARD_BUILD,
      detectors: {
        containsCardData: (text) => { if (watched.has(text)) calls.data += 1; return containsCardData(text); },
        containsCardSecret: (text) => { if (watched.has(text)) calls.secret += 1; return containsCardSecret(text); },
      },
    };
    const owner = { actorRef: cardSyncActorRef('test-owner') };
    const local = new SqliteStateRepo({ file: ':memory:', cardGuards: counted });
    const add = vi.spyOn(Set.prototype, 'add');
    try {
      const card = local.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', currency: 'USD' });
      local.importCardTransactions(cardImport(card.id, [cardRow()]));
      const id = local.listCardTransactions()[0].id;
      const refusedEdit = () => {
        const before = { ...calls };
        expect(() => local.updateCardTransaction(id, { notes: secret }, owner)).toThrow(HoldrRefusal);
        return { data: calls.data - before.data, secret: calls.secret - before.secret };
      };
      const first = refusedEdit();
      const second = refusedEdit();
      // The number check came first and found the secret clean; it was still not remembered, so the
      // identical second edit asks both detectors again, exactly as the first did.
      expect(first.data).toBeGreaterThanOrEqual(1);
      expect(first.secret).toBeGreaterThanOrEqual(1);
      expect(second).toEqual(first);
      expect(local.getCardTransaction(id)?.notes).toBeUndefined();

      // The other way round, at the SQL boundary: the secret function first, then the number function.
      const db = local.internalGetDb();
      const secretFn = db.prepare(`SELECT ${CARD_GUARD_BUILD.cardSecretFunction}(?)`).pluck();
      const dataFn = db.prepare(`SELECT ${CARD_GUARD_BUILD.cardDataFunction}(?)`).pluck();
      for (let i = 0; i < 2; i += 1) {
        const before = { ...calls };
        expect([secretFn.get(pan), dataFn.get(pan), secretFn.get(secret), dataFn.get(secret)]).toEqual([0, 1, 1, 0]);
        expect({ data: calls.data - before.data, secret: calls.secret - before.secret }).toEqual({ data: 3, secret: 3 });
      }
      expect(add.mock.calls.some(([value]) => watched.has(value as string))).toBe(false);
    } finally {
      add.mockRestore();
      local.close();
    }
  });

  it('remembers a text both detectors found clean once, and answers exactly as the detectors do', () => {
    const text = 'SYNTHETIC CLEAN TEXT';
    const calls = { data: 0, secret: 0 };
    const counted: CardGuardBuild = {
      ...CARD_GUARD_BUILD,
      detectors: {
        containsCardData: (value) => { if (value === text) calls.data += 1; return containsCardData(value); },
        containsCardSecret: (value) => { if (value === text) calls.secret += 1; return containsCardSecret(value); },
      },
    };
    const local = new SqliteStateRepo({ file: ':memory:', cardGuards: counted });
    const add = vi.spyOn(Set.prototype, 'add');
    try {
      const db = local.internalGetDb();
      const secretFn = db.prepare(`SELECT ${CARD_GUARD_BUILD.cardSecretFunction}(?)`).pluck();
      const dataFn = db.prepare(`SELECT ${CARD_GUARD_BUILD.cardDataFunction}(?)`).pluck();
      for (let i = 0; i < 3; i += 1) expect([dataFn.get(text), secretFn.get(text), secretFn.get(text)]).toEqual([0, 0, 0]);
      expect(calls).toEqual({ data: 1, secret: 1 });
      expect(add.mock.calls.filter(([value]) => value === text)).toHaveLength(1);
    } finally {
      add.mockRestore();
      local.close();
    }
    // Every answer is the detector's own, in either order and on repeats, whatever the other detector says.
    const texts = ['', 'SYNTHETIC CAFE', 'USD', '2026-10-17T10:00:00.000Z', ['4111', '1111', '1111', '1111'].join(' '),
      '{"cvv":"123","expiry":"12/29"}', 'CVV 123', 'PIN 1234', 'expiry 12/29', 'safe\0' + '4111111111111111', 'XXXX-90003',
      'ALPHA 4012 BRAVO 8888 CHARLIE 8888', `SYNTHETIC ${'MERCHANT '.repeat(40)}`, 'Café ünïcode ✓'];
    for (const secretFirst of [false, true]) {
      const detectors = rememberingCleanTexts(CARD_GUARD_BUILD.detectors);
      for (let repeat = 0; repeat < 2; repeat += 1) {
        for (const value of texts) {
          let answers: boolean[];
          if (secretFirst) {
            const secretAnswer = detectors.containsCardSecret(value);
            answers = [detectors.containsCardData(value), secretAnswer];
          } else {
            answers = [detectors.containsCardData(value), detectors.containsCardSecret(value)];
          }
          expect(answers).toEqual([containsCardData(value), containsCardSecret(value)]);
        }
      }
    }
  });

  it('pins the detectors and guard SQL to the guard revision', () => {
    // Fails on purpose when a detector source or the guard SQL changes. If the
    // change tightens the guards, bump CARD_GUARD_BUILD's revision and rename
    // its functions in the same commit, then re-pin. Re-pin alone only for a
    // behaviour-preserving change. See the rule at CARD_GUARD_BUILD.
    //
    // Columns and tables a schema upgrade adds (v14's; v15's 28 card-sync
    // tables and new columns) get the guards every column gets: re-pin
    // guardSql alone, and keep the v13 guards byte for byte (the v13 upgrade
    // test checks it); a build of the older schema refuses the newer database
    // by its schema version before it reads a trigger. Any tightening of the
    // checks on existing columns, of how the guards are written, or of a
    // detector still bumps the revision and renames the functions.
    const source = (name: string) => readFileSync(new URL(`../../../../packages/shared/src/${name}`, import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(CARD_GUARD_BUILD.detectors.containsCardData).toBe(containsCardData);
    expect(CARD_GUARD_BUILD.detectors.containsCardSecret).toBe(containsCardSecret);
    expect({
      revision: CARD_GUARD_BUILD.revision,
      functions: [CARD_GUARD_BUILD.cardDataFunction, CARD_GUARD_BUILD.cardSecretFunction],
      detectorSources: Object.fromEntries(
        ['cardNumbers.ts', 'cardSecrets.ts', 'cardText.ts'].map((name) => [name, sha256(source(name))]),
      ),
      guardSql: sha256(guardSql(rawDb(repo)).sort().join('\n')),
      v14TablesWithoutV15: sha256(v13GuardSql(rawDb(repo)).map(withoutChecks(V15_COLUMNS)).sort().join('\n')),
    }).toEqual({
      revision: 4,
      functions: ['holdr_card_data_v4', 'holdr_card_secret_v4'],
      detectorSources: {
        // Phase 1 5d0467e's detectors; 5840f95, and later the synthetic card endings in three examples, changed
        // comments only (the code without them is identical).
        'cardNumbers.ts': 'cfd573e9305108eee42e5770e4eb67ac378ccc465a873bb224b2b093eb8dfa19',
        'cardSecrets.ts': '2ab865cba54a8199f325c971a3d5cd2e1fd49edb661eeab59c15c5d131912102',
        'cardText.ts': 'ee64f4fe9c6e090827f30611c44995bf8848fd03a764c987683762772fbf2202',
      },
      // Phase 3's v13 guards (GUARD_SQL_78B291D: 1f1ffbf's with revision 4 and
      // the v4 names), the same checks on the v14 columns, and on v15's new
      // columns and 28 tables, per the rule above (re-pinned for v15, E1b).
      guardSql: '52bb4e96784d3b21ad98f3599ebae641e626472d8dbd6c93e7f9e695fe0a7c5c',
      // v14's pin, unchanged: without the lines of v15's columns, the guards of
      // v13's three tables are exactly the guards v14 installed (design §3.5).
      v14TablesWithoutV15: 'bcd2e9c9c8c7092902ce26e795eb6238aec5bd5a21256389f170f548ca527424',
    });
  });

  /**
   * Opens `file` while a second connection runs `upgrade` and commits right
   * after the constructor's lock-free preflight, before its first pragma: the
   * window in which another process could upgrade the database.
   */
  function openDuringConcurrentUpgrade(file: string, upgrade: (other: RawDb) => void) {
    const pragma = Database.prototype.pragma;
    let committed: ReturnType<typeof snapshot> | undefined;
    const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(
      function (this: RawDb, ...args: Parameters<RawDb['pragma']>) {
        if (!committed && args[0] === 'foreign_keys = ON') {
          const other = new Database(file);
          try {
            upgrade(other);
          } finally {
            other.close();
          }
          committed = snapshot(file);
        }
        return pragma.apply(this, args);
      } as RawDb['pragma'],
    );
    let error: unknown;
    try {
      new SqliteStateRepo({ file }).close();
    } catch (caught) {
      error = caught;
    } finally {
      spy.mockRestore();
    }
    repo = new SqliteStateRepo({ file: path.join(dir, 'unrelated.db') });
    return { error, committed };
  }

  /** A newer-revision update guard that also refuses one nickname this build allows. */
  function installNewerGuard(other: RawDb): void {
    const current = other.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_card_accounts_guard_update'")
      .get() as { sql: string };
    other.exec('DROP TRIGGER trg_card_accounts_guard_update');
    other.exec(current.sql
      .replace(revisionLine(GUARD_REVISION), revisionLine(NEWER_REVISION))
      .replace('  SELECT CASE\n', "  SELECT CASE\n    WHEN NEW.\"nickname\" = 'Gold' THEN RAISE(ABORT, 'newer rule')\n"));
  }

  it.each([
    ['a guard revision bump at v14', installNewerGuard,
      new RegExp(`^card guards are revision ${NEWER_REVISION}, newer than this build's ${GUARD_REVISION}`)],
    ['a v16 schema with newer guards', (other: RawDb) => {
      installNewerGuard(other);
      other.exec('PRAGMA user_version = 16');
    }, /^database schema v16 is newer than this build supports \(v15\)/],
    ['a v16 schema that kept the current guards', (other: RawDb) => {
      other.exec('CREATE TABLE card_future_links (id TEXT PRIMARY KEY); PRAGMA user_version = 16;');
    }, /^database schema v16 is newer than this build supports \(v15\)/],
  ])('refuses %s committed by another connection after the preflight', (_label, upgrade, expected) => {
    const file = seedAndClose();
    const { error, committed } = openDuringConcurrentUpgrade(file, upgrade);
    expect(committed, 'the concurrent upgrade ran inside the window').toBeDefined();
    expect(String((error as Error | undefined)?.message)).toMatch(expected);
    expect(snapshot(file)).toEqual(committed);
  });

  it('holds the write lock from the compatibility check through every migration and the guard refresh', () => {
    const file = path.join(dir, 'fresh.db');
    const exec = Database.prototype.exec;
    const attempts = new Set<string>();
    const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: RawDb, source: string) {
      const block = /^-- @block ([0-9.a-z]+)\n/.exec(source)?.[1];
      const step = source.includes('CREATE TABLE IF NOT EXISTS accounts') ? 'base schema'
        : source.includes('CREATE TABLE card_accounts') ? 'card tables'
          : source.includes('ALTER TABLE card_accounts ADD COLUMN last5') ? 'card reports columns'
            : block ? `card sync block ${block}`
              : source.startsWith('CREATE TRIGGER trg_card_') ? 'guard refresh'
                : null;
      if (step) {
        const other = new Database(file, { timeout: 0 });
        try {
          other.pragma('user_version = 99');
          attempts.add(`${step}: another connection wrote`);
        } catch (caught) {
          attempts.add(`${step}: ${(caught as Error).message}`);
        } finally {
          other.close();
        }
      }
      return exec.call(this, source);
    } as RawDb['exec']);
    try {
      repo.close();
      repo = new SqliteStateRepo({ file });
    } finally {
      spy.mockRestore();
    }
    expect(attempts).toEqual(new Set([
      'base schema: database is locked',
      'card tables: database is locked',
      'card reports columns: database is locked',
      // Every step of the v15 migration that runs a design block (design §3.1).
      ...['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '3.4a', '2.10', '3.4c', '2.8', '2.9', '2.11', '2.12', '2.13', '2.14',
        '2.15', '2.16', '2.17', '2.18', '2.19'].map((block) => `card sync block ${block}: database is locked`),
      'guard refresh: database is locked',
    ]));
    expect(repo.schemaVersion()).toBe(15);
  });
});
