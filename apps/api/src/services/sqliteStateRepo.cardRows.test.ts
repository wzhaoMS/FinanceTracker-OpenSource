import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cardExternalIdHash,
  type CardTransaction,
  type CardTransactionKind,
  type CardTransactionStatus,
} from '@finance-tracker/shared';
import { cardSyncActorRef } from './cardSyncDigests.js';
import { SqliteStateRepo, type CardImportRow, type CardTransactionSort } from './sqliteStateRepo.js';

// Card reads take raw rows, arrays of values, and find each value by its column's name: better-sqlite3 builds those
// in about half the time named rows take. Every read must still give exactly the objects the named rows gave: the same
// fields in the same order, a NULL column's field present as undefined. Synthetic rows only: made-up merchants, amounts
// and references.

let dir: string;
let repo: SqliteStateRepo;
const OWNER = { actorRef: cardSyncActorRef('test-owner') };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-card-rows-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const COLUMNS = `id, card_account_id, source, external_id_hash, fingerprint, transaction_date,
  posted_date, status, amount_minor, currency, original_amount_minor, original_currency, kind, description,
  merchant, issuer_category, user_category, notes, import_batch_id, dismissed_at,
  created_at, updated_at`;
const NULLABLE = ['external_id_hash', 'fingerprint', 'posted_date', 'original_amount_minor', 'original_currency', 'merchant',
  'issuer_category', 'user_category', 'notes', 'import_batch_id', 'dismissed_at'];
const SORTS: CardTransactionSort[] = ['date-desc', 'date-asc', 'amount-desc', 'amount-asc'];

interface CardTransactionRow {
  id: string;
  card_account_id: string;
  source: string;
  external_id_hash: string | null;
  fingerprint: string | null;
  transaction_date: string;
  posted_date: string | null;
  status: CardTransactionStatus;
  amount_minor: number;
  currency: string;
  original_amount_minor: number | null;
  original_currency: string | null;
  kind: CardTransactionKind;
  description: string;
  merchant: string | null;
  issuer_category: string | null;
  user_category: string | null;
  notes: string | null;
  import_batch_id: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** How card reads mapped better-sqlite3's named rows before they read raw ones: the oracle. */
function mapNamedRowAsBefore(row: CardTransactionRow): CardTransaction {
  return {
    id: row.id,
    cardAccountId: row.card_account_id,
    source: row.source,
    externalIdHash: row.external_id_hash ?? undefined,
    fingerprint: row.fingerprint ?? undefined,
    transactionDate: row.transaction_date,
    postedDate: row.posted_date ?? undefined,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    originalAmountMinor: row.original_amount_minor ?? undefined,
    originalCurrency: row.original_currency ?? undefined,
    kind: row.kind,
    description: row.description,
    merchant: row.merchant ?? undefined,
    issuerCategory: row.issuer_category ?? undefined,
    userCategory: row.user_category ?? undefined,
    notes: row.notes ?? undefined,
    importBatchId: row.import_batch_id ?? undefined,
    dismissedAt: row.dismissed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every stored row as a named read gave it, by id. */
function rowsAsBefore(): Map<string, CardTransaction> {
  const rows = repo.internalGetDb().prepare(`SELECT ${COLUMNS} FROM card_transactions`).all() as CardTransactionRow[];
  return new Map(rows.map((row) => [row.id, mapNamedRowAsBefore(row)]));
}

/** The same objects as before, field for field, in the same field order (so the same JSON too). */
function expectRowsAsBefore(read: readonly CardTransaction[], before: Map<string, CardTransaction>, label: string): void {
  const expected = read.map((row) => before.get(row.id));
  expect(read, label).toStrictEqual(expected);
  expect(read.map((row) => Object.keys(row)), label).toEqual(expected.map((row) => Object.keys(row!)));
  expect(JSON.stringify(read), label).toBe(JSON.stringify(expected));
}

function seed(): { pendingId: string } {
  const card = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD' } as never);
  const other = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '0004', currency: 'USD' } as never);
  const row = (patch: Partial<CardImportRow>): CardImportRow => ({
    transactionDate: '2026-09-10', postedDate: '2026-09-11', status: 'posted', amountMinor: 1250, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE COFFEE BAR', merchant: 'Sample Coffee', issuerCategory: 'Restaurant', ...patch,
  });
  const importRows = (cardAccountId: string, rows: CardImportRow[]) =>
    repo.importCardTransactions({ cardAccountId, source: 'test-sync', parserVersion: 'test@1', rows });
  importRows(card.id, [
    row({ externalIdHash: cardExternalIdHash('ROWS-ABROAD'), originalAmountMinor: 1_100, originalCurrency: 'EUR', description: 'SAMPLE CAFE ABROAD' }),
    // No issuer reference: stored by its fingerprint.
    row({ transactionDate: '2026-09-02', merchant: null, issuerCategory: null, description: 'SAMPLE HARDWARE' }),
    row({ externalIdHash: cardExternalIdHash('ROWS-PENDING'), status: 'pending', postedDate: null, transactionDate: '2026-09-08', description: 'SAMPLE BISTRO' }),
    row({ externalIdHash: cardExternalIdHash('ROWS-DISMISSED'), status: 'pending', postedDate: null, amountMinor: 640, description: 'SAMPLE KIOSK' }),
    row({ externalIdHash: cardExternalIdHash('ROWS-REFUND'), kind: 'refund', amountMinor: -500, description: 'SAMPLE OUTLET RETURN' }),
    row({ externalIdHash: cardExternalIdHash('ROWS-PAYMENT'), kind: 'payment', amountMinor: -20_000, description: 'PAYMENT THANK YOU', merchant: null, issuerCategory: null }),
  ]);
  // A later import's posted row may be the pending one's posted version.
  importRows(card.id, [row({ externalIdHash: cardExternalIdHash('ROWS-POSTED'), transactionDate: '2026-09-09', postedDate: '2026-09-10', description: 'SAMPLE BISTRO' })]);
  importRows(other.id, [row({ externalIdHash: cardExternalIdHash('ROWS-OTHER'), amountMinor: 9_999, description: 'SAMPLE BOOKS' })]);
  const stored = repo.listCardTransactions();
  const find = (description: string, status = 'posted') => stored.find((item) => item.description === description && item.status === status)!;
  repo.updateCardTransaction(find('SAMPLE CAFE ABROAD').id, { userCategory: 'Coffee', notes: 'synthetic note' }, OWNER);
  repo.updateCardTransaction(find('SAMPLE KIOSK', 'pending').id, { status: 'removed' }, OWNER);
  // A card-sync row has no import batch: planted beside the imported ones, as the sync path needs a paired device.
  repo.internalGetDb().prepare(`INSERT INTO card_transactions (id, card_account_id, source, external_id_hash, transaction_date,
      posted_date, status, amount_minor, currency, kind, description, merchant, issuer_category, card_scope_id, created_at, updated_at)
    SELECT ?, card_account_id, source, ?, transaction_date, posted_date, status, amount_minor, currency, kind, 'SAMPLE SYNCED SHOP',
      merchant, issuer_category, card_scope_id, created_at, updated_at FROM card_transactions WHERE id = ?`)
    .run(`card-txn-${'k'.repeat(32)}`, cardExternalIdHash('ROWS-SYNCED'), find('SAMPLE BOOKS').id);
  return { pendingId: find('SAMPLE BISTRO', 'pending').id };
}

it('reads every card row as the same object the named rows gave, NULL columns included', () => {
  const { pendingId } = seed();
  const db = repo.internalGetDb();
  // Each nullable column is stored both NULL and set, so both mappings are compared.
  for (const column of NULLABLE) {
    const [nulls, set] = db.prepare(`SELECT sum(${column} IS NULL), sum(${column} IS NOT NULL) FROM card_transactions`).raw().get() as number[];
    expect(nulls, column).toBeGreaterThan(0);
    expect(set, column).toBeGreaterThan(0);
  }
  const before = rowsAsBefore();
  const statuses: CardTransactionStatus[] = ['pending', 'posted', 'removed'];

  const all = repo.listCardTransactions();
  expect(all).toHaveLength(before.size);
  expectRowsAsBefore(all, before, 'listCardTransactions');
  expectRowsAsBefore(repo.listCardTransactionsMatching({ statuses }), before, 'listCardTransactionsMatching');
  expectRowsAsBefore(repo.listCardTransactionsMatching(), before, 'listCardTransactionsMatching default');
  expect(repo.listCardTransactionsMatching({ statuses })).toHaveLength(before.size);
  for (const sort of SORTS) {
    const sorted = repo.listCardTransactionsSorted({ statuses }, sort);
    expect(sorted, sort).toHaveLength(before.size);
    expectRowsAsBefore(sorted, before, `listCardTransactionsSorted ${sort}`);
    const page = repo.queryCardTransactions({ statuses }, { sort, limit: 3, offset: 2 });
    expect(page.transactions.map((row) => row.id), sort).toEqual(sorted.slice(2, 5).map((row) => row.id));
    expectRowsAsBefore(page.transactions, before, `queryCardTransactions ${sort}`);
  }
  for (const id of before.keys()) expectRowsAsBefore([repo.getCardTransaction(id)!], before, `getCardTransaction ${id}`);
  expect(repo.getCardTransaction('card-txn-missing')).toBeNull();
  const versions = repo.listPossiblePostedCardVersions(pendingId);
  expect(versions.map((row) => row.description)).toEqual(['SAMPLE BISTRO']);
  expectRowsAsBefore(versions, before, 'listPossiblePostedCardVersions');
});
