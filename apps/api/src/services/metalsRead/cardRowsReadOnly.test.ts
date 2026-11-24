import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withReadOnlyDatabase } from '../../cli/operatorIo.js';
import { installMetalsSchema } from '../metals/index.js';
import { SqliteStateRepo, type CardImportRow } from '../sqliteStateRepo.js';
import { createMetalsPriceStore, readMetalsPriceBars } from './prices.js';
import { metalsCardRowsReadOnly, readMetalsLedgerInputs } from './source.js';

// Synthetic only: invented card accounts, rows, amounts and closes on a scratch database this build made.

let dir: string;
let file: string;
let repo: SqliteStateRepo;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-read-only-'));
  file = path.join(dir, 'finance.db');
  repo = new SqliteStateRepo({ file });
});

afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (patch: Partial<CardImportRow>): CardImportRow => ({
  transactionDate: '2030-01-11', postedDate: null, status: 'posted', amountMinor: 0, currency: 'USD', kind: 'purchase',
  description: 'SAMPLE STORE PURCHASE', merchant: null, issuerCategory: null, ...patch,
});

/**
 * Whether `fn` refused, as data, for the reader's one declared refusal only (kill standard §9a and 3(e)): a TypeError by its
 * name and its constant message (the literal at its throw site in source.ts). Anything else is re-thrown unchanged; no
 * throw at all is 'not refused'.
 */
const refusalOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TypeError && error.name === 'TypeError' && error.message === 'the read-only card reader reads only what the metals read asks') {
      return 'refused';
    }
    throw error;
  }
  return 'not refused';
};

/**
 * A card-sync coverage window stored raw, beside the import's own: the read is compared here, not the write path, so
 * its observation set is never made (foreign keys are off for this insert only).
 */
function insertWindow(id: string, cardAccountId: string, ledgerState: string, requested: { start: string; end: string } | null,
  completeness: 'partial' | 'complete'): void {
  const db = repo.internalGetDb();
  const scope = db.prepare('SELECT card_scope_id FROM card_coverage_windows WHERE card_account_id = ? LIMIT 1').pluck().get(cardAccountId) as string;
  const at = '2030-03-19T12:00:00.000Z';
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(`INSERT INTO card_coverage_windows (id, card_account_id, card_scope_id, source_kind, source, import_batch_id, observation_set_id,
        entry_ordinal, status, requested_start, requested_end, requested_basis, observed_start, observed_end, observed_basis, claimed_completeness,
        verified_completeness, termination, page_count, evidence, ledger_state, observed_at, recorded_at, updated_at)
      VALUES (?, ?, ?, 'extension', 'sample-sync', NULL, ?, 0, 'posted', ?, ?, ?, NULL, NULL, NULL, ?, ?, 'end-marker', 1, 'extension-claimed', ?, ?, ?, ?)`)
      .run(`card-cover-${id.repeat(32)}`, cardAccountId, scope, `sample-set-${id}`, requested?.start ?? null, requested?.end ?? null,
        requested === null ? null : 'transaction', completeness, completeness, ledgerState, at, at, at);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Card accounts of each shape (a nickname or none, a last 5, closed) and rows of each status and kind, two on one day. */
function seedCards(): void {
  const visa = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', nickname: 'Sample Visa', last4: '1111', currency: 'USD' });
  const plain = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '3333', currency: 'USD' });
  const five = repo.createCardAccount({ issuer: 'thirdbank', owner: 'joint', nickname: 'Sample Gold', last5: '90003', currency: 'USD' });
  repo.updateCardAccount(plain.id, { status: 'closed' });
  const coverage = { start: '2030-01-01', end: '2030-03-19' };
  repo.importCardTransactions({ cardAccountId: visa.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
    row({ transactionDate: '2030-02-16', amountMinor: 4000, merchant: 'Sample Merchant' }),
    row({ transactionDate: '2030-01-11', amountMinor: 2000 }),
    row({ transactionDate: '2030-01-11', amountMinor: 2500, description: 'SAMPLE STORE SECOND' }),
    row({ transactionDate: '2030-01-12', amountMinor: -500, kind: 'refund' }),
    row({ transactionDate: '2030-01-13', amountMinor: -9000, kind: 'payment', description: 'SAMPLE PAYMENT THANK YOU' }),
    row({ transactionDate: '2030-03-18', amountMinor: 1500, status: 'pending' }),
  ] });
  repo.importCardTransactions({ cardAccountId: plain.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
    row({ transactionDate: '2030-02-10', amountMinor: 3000, description: 'SAMPLE WAREHOUSE' }),
  ] });
  repo.importCardTransactions({ cardAccountId: five.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
    row({ transactionDate: '2030-01-20', amountMinor: 700, kind: 'fee', description: 'SAMPLE ANNUAL FEE' }),
  ] });
}

describe('metals read side: card rows without a writer', () => {
  it('reads exactly what the repository reads, on a read-only query_only handle', () => {
    installMetalsSchema(repo.internalGetDb());
    seedCards();
    const [visa, plain, five] = repo.listCardAccounts();
    // A second declared range beside the first (merged per account), an import that declares none, and card-sync windows
    // of each shape: committed and verified complete, committed with no request, and one not committed (never read).
    repo.importCardTransactions({ cardAccountId: visa.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2029-12-01', end: '2029-12-31' },
      rows: [row({ transactionDate: '2029-12-15', amountMinor: 900, kind: 'fee', description: 'SAMPLE LATE FEE' })] });
    repo.importCardTransactions({ cardAccountId: five.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2030-02-01', amountMinor: 800, kind: 'fee', description: 'SAMPLE OTHER FEE' })] });
    insertWindow('a', plain.id, 'committed', { start: '2029-11-01', end: '2029-11-30' }, 'complete');
    insertWindow('b', visa.id, 'committed', null, 'partial');
    insertWindow('c', five.id, 'observed-uncommitted', { start: '2029-10-01', end: '2029-10-31' }, 'complete');
    const throughRepo = readMetalsLedgerInputs(repo.internalGetDb(), repo, { links: true });
    expect(throughRepo.cardAccounts).toHaveLength(3);
    expect(throughRepo.cardRows.map((entry) => entry.amountMinor)).toEqual([2000, 2500, 3000, 4000]);
    // Read on the command's own handle; every assertion is in the test's body, after the handle is closed.
    const read = withReadOnlyDatabase(file, (db) => {
      const reader = metalsCardRowsReadOnly(db);
      return {
        queryOnly: db.pragma('query_only', { simple: true }),
        inputs: readMetalsLedgerInputs(db, reader, { links: true }),
        accounts: reader.listCardAccounts(),
        rows: reader.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['purchase'] }),
        refunds: reader.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['refund'] }),
        coverage: reader.listCardCoverage(),
        windows: reader.listCardCoverageWindows({ ledgerStates: ['committed'] }),
        changes: db.prepare('SELECT total_changes()').pluck().get(),
      };
    });
    expect(read.queryOnly).toBe(1);
    expect(read.inputs).toEqual(throughRepo);
    // Field by field as the repository maps them: a NULL is absent, never null.
    const pick = <T extends object, K extends keyof T>(entry: T, keys: readonly K[]) => Object.fromEntries(keys.map((key) => [key, entry[key]]));
    const accountKeys = ['id', 'issuer', 'owner', 'nickname', 'last4', 'last5', 'status'] as const;
    expect(read.accounts).toStrictEqual(repo.listCardAccounts().map((entry) => pick(entry, accountKeys)));
    const rowKeys = ['id', 'cardAccountId', 'transactionDate', 'amountMinor', 'kind', 'currency', 'merchant', 'description'] as const;
    expect(read.rows).toStrictEqual(repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['purchase'] }).map((entry) => pick(entry, rowKeys)));
    expect(read.refunds).toStrictEqual(repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['refund'] }).map((entry) => pick(entry, rowKeys)));
    expect(read.coverage).toStrictEqual(repo.listCardCoverage().map((entry) => pick(entry, ['cardAccountId', 'ranges'] as const)));
    expect(read.windows).toStrictEqual(repo.listCardCoverageWindows({ ledgerStates: ['committed'] })
      .map((entry) => pick(entry, ['cardAccountId', 'verifiedCompleteness', 'requested'] as const)));
    // Each read had something to read: the posted refund, the merged ranges and every committed window.
    expect([read.refunds.length, read.coverage.map((entry) => entry.ranges.length), read.windows.length]).toEqual([1, [1, 1, 1], 6]);
    expect(read.coverage.find((entry) => entry.cardAccountId === visa.id)?.ranges).toEqual([{ start: '2029-12-01', end: '2030-03-19' }]);
    expect(read.changes).toBe(0);
  });

  it('reads only what the metals read asks: any other query is refused', () => {
    seedCards();
    const queries = [{ statuses: ['pending'], kinds: ['purchase'] }, { statuses: ['posted'], kinds: ['fee'] },
      { statuses: ['posted', 'pending'], kinds: ['purchase'] }, { statuses: ['posted'], kinds: ['purchase', 'refund'] }];
    const filters = [{ ledgerStates: ['observed-uncommitted'] }, { ledgerStates: ['committed', 'rejected'] }, { ledgerStates: ['committed'], cardAccountId: 'x' }];
    const read = withReadOnlyDatabase(file, (db) => {
      const reader = metalsCardRowsReadOnly(db);
      return {
        others: queries.map((query) => refusalOf(() => reader.listCardTransactionsMatching(query as never))),
        windows: filters.map((filter) => refusalOf(() => reader.listCardCoverageWindows(filter as never))),
        posted: reader.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['purchase'] }).length,
        refunds: reader.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['refund'] }).length,
      };
    });
    expect(read.others).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(read.windows).toEqual(['refused', 'refused', 'refused']);
    expect([read.posted, read.refunds]).toEqual([4, 1]);
  });
});

describe('metals prices: the stored bars without the store', () => {
  it('reads every stored bar of a metal as the store does, any source, an unreadable close included', () => {
    const insert = repo.internalGetDb().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'daily', ?, ?, ?)`);
    insert.run('holdr:metal:XAU', '2030-01-03', 2001.5, 'cnbc-spot-daily');
    insert.run('holdr:metal:XAU', '2030-01-02', 2000, 'cnbc-spot-daily');
    insert.run('holdr:metal:XAU', '2030-01-02', 2010, 'another-source');
    insert.run('holdr:metal:XAU', '2030-01-06', 0, 'cnbc-spot-daily');
    insert.run('holdr:metal:XAG', '2030-01-02', 25.25, 'cnbc-spot-daily');
    const store = createMetalsPriceStore(repo.internalGetDb());
    const metals = ['XAU', 'XAG', 'XPT', 'XPD'] as const;
    const bars = withReadOnlyDatabase(file, (db) => metals.map((metal) => readMetalsPriceBars(db, metal)));
    expect(bars[0]).toEqual([
      { date: '2030-01-02', close: '2010' }, { date: '2030-01-02', close: '2000' }, { date: '2030-01-03', close: '2001.5' },
      { date: '2030-01-06', close: 'unreadable' },
    ]);
    expect(metals.map((metal, index) => [metal, bars[index]])).toEqual(metals.map((metal) => [metal, store.bars(metal)]));
  });
});
