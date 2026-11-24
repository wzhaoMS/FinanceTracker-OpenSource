import Database from 'better-sqlite3';

import { cardExternalIdHash, cardTransactionFingerprint, toLetterHex } from '@finance-tracker/shared';
import { randomBytes } from 'node:crypto';

import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import {
  CARD_GUARD_BUILD,
  SqliteStateRepo,
  type CardImportInput,
  type CardImportRow,
} from '../services/sqliteStateRepo.js';
import { downgradeCardSchema } from './cardSchemaDowngrade.js';

type RawDb = Database.Database;

/** The fixed clock of the card-sync migration tests. */
export const CARD_TEST_T0 = '2026-10-17T10:00:00.000Z';

/** The signed-in owner of the seeded ledgers, as the ledger events name them. */
export const CARD_TEST_OWNER_REF = cardSyncActorRef('local-user-owner');

/** One row of a redacted export (all synthetic). */
export function cardFileRow(overrides: Partial<CardImportRow> = {}): CardImportRow {
  return {
    transactionDate: '2026-09-03', postedDate: '2026-09-04', status: 'posted', amountMinor: 1250, currency: 'USD',
    kind: 'purchase', description: 'BLUE BOTTLE COFFEE', ...overrides,
  };
}

/** Registers this build's card guard functions on a raw connection, so it can write guarded card rows. */
export function withCardFunctions(db: RawDb): RawDb {
  const { detectors } = CARD_GUARD_BUILD;
  db.function(CARD_GUARD_BUILD.cardDataFunction, { deterministic: true }, (value: unknown) =>
    (typeof value === 'string' && detectors.containsCardData(value) ? 1 : 0));
  db.function(CARD_GUARD_BUILD.cardSecretFunction, { deterministic: true }, (value: unknown) =>
    (typeof value === 'string' && detectors.containsCardSecret(value) ? 1 : 0));
  return db;
}

/** A brokerage account with a trade and a cash event, so upgrades are seen to leave non-card data alone. */
export function seedBrokerageForCardTests(repo: SqliteStateRepo): void {
  repo.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 250, currency: 'USD', accountNumber: 'X2468' });
  repo.createTransaction({
    id: 't1', accountId: 'fid', symbol: 'AAPL', date: '2026-05-04', quantity: 10, pricePerUnit: 150, currency: 'USD',
    sourceFingerprint: 'a'.repeat(64),
  });
  repo.insertCashEvent({
    accountId: 'fid', date: '2026-05-07', eventType: 'dividend', amount: 12.34, currency: 'USD', broker: 'fidelity',
    accountLast4: '2468', description: 'DIVIDEND RECEIVED SYNTHETIC FUND', sourceFingerprint: 'c'.repeat(64),
  });
}

export interface SeededCardLedger {
  amexId: string;
  chaseId: string;
  /** Every import, in order, as given: replaying them must change nothing. */
  imports: CardImportInput[];
  /** A row the owner categorized and annotated. */
  editedId: string;
  /** A pending row the owner dismissed. */
  dismissedId: string;
}

/**
 * Two card accounts and their ledgers through the repository's own API:
 * references and fingerprints, pending and posted rows, a refund, a payment,
 * a foreign-currency row, a declared coverage and one without, a rejected
 * count, an owner's category and notes, and a dismissal.
 */
export function seedCardLedger(repo: SqliteStateRepo): SeededCardLedger {
  const amexId = repo.createCardAccount({
    issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', last5: '60003', currency: 'USD',
  }).id;
  const chaseId = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' }).id;
  const imports: CardImportInput[] = [
    {
      cardAccountId: amexId, source: 'amex-csv', parserVersion: 'amex-csv@1.0.0', rejectedCount: 1,
      coverage: { start: '2026-09-01', end: '2026-09-30' },
      rows: [
        cardFileRow({ externalIdHash: cardExternalIdHash('320252940000000101'), merchant: 'Blue Bottle', issuerCategory: 'Restaurants' }),
        cardFileRow({
          externalIdHash: cardExternalIdHash('320252940000000102'), transactionDate: '2026-09-28', postedDate: null, status: 'pending',
          amountMinor: 4500, description: 'SYNTHETIC HARDWARE',
        }),
        cardFileRow({ transactionDate: '2026-09-10', postedDate: '2026-09-11', amountMinor: 899, description: 'SYNTHETIC BOOKS' }),
        cardFileRow({ transactionDate: '2026-09-10', postedDate: '2026-09-11', amountMinor: 899, description: 'SYNTHETIC BOOKS' }),
        cardFileRow({
          externalIdHash: cardExternalIdHash('320252940000000103'), transactionDate: '2026-09-15', postedDate: '2026-09-16',
          amountMinor: -1250, kind: 'refund', description: 'BLUE BOTTLE COFFEE REFUND',
        }),
        cardFileRow({
          externalIdHash: cardExternalIdHash('320252940000000104'), transactionDate: '2026-09-20', postedDate: '2026-09-20',
          amountMinor: -50000, kind: 'payment', description: 'PAYMENT THANK YOU',
        }),
        cardFileRow({
          externalIdHash: cardExternalIdHash('320252940000000105'), transactionDate: '2026-09-22', postedDate: '2026-09-24',
          amountMinor: 2731, originalAmountMinor: 2500, originalCurrency: 'EUR', description: 'SYNTHETIC CAFE PARIS',
        }),
      ],
    },
    {
      cardAccountId: chaseId, source: 'chase-csv', parserVersion: 'csv@1.0.0',
      rows: [
        cardFileRow({
          externalIdHash: cardExternalIdHash('CHASE-SYN-0001'), transactionDate: '2026-10-01', postedDate: null, status: 'pending',
          amountMinor: 6000, description: 'SYNTHETIC HOTEL HOLD',
        }),
        cardFileRow({ externalIdHash: cardExternalIdHash('CHASE-SYN-0002'), transactionDate: '2026-10-02', postedDate: '2026-10-03' }),
      ],
    },
  ];
  for (const input of imports) repo.importCardTransactions(input);
  const rows = repo.listCardTransactions();
  const edited = rows.find((row) => row.cardAccountId === amexId && row.merchant === 'Blue Bottle')!;
  repo.updateCardTransaction(edited.id, { userCategory: 'Dining', notes: 'team coffee' }, { actorRef: CARD_TEST_OWNER_REF });
  const hold = rows.find((row) => row.cardAccountId === chaseId && row.status === 'pending')!;
  repo.updateCardTransaction(hold.id, { status: 'removed' }, { actorRef: CARD_TEST_OWNER_REF });
  return { amexId, chaseId, imports, editedId: edited.id, dismissedId: hold.id };
}

export interface V14CardLedgerFile extends SeededCardLedger {
  /** Rows a v13 or v14 import stored as `removed` (v15 refuses such rows), planted into the v14 file. */
  legacyRemovedIds: string[];
}

/**
 * A v14 database file as main's v14 build left it: brokerage data, the seeded
 * card ledger, and two rows a v13/v14 import stored as `removed` (one with a
 * posted date, one without). Written by this build, then turned back into
 * v14 (cardSchemaDowngrade.ts), so it carries main's v14 guards byte for byte.
 */
export function writeV14CardLedger(file: string, now: () => Date = () => new Date(CARD_TEST_T0)): V14CardLedgerFile {
  const repo = new SqliteStateRepo({ file, now });
  let seeded: SeededCardLedger;
  try {
    seedBrokerageForCardTests(repo);
    seeded = seedCardLedger(repo);
  } finally {
    repo.close();
  }
  downgradeCardSchema(file, 14);
  const db = withCardFunctions(new Database(file));
  try {
    const batch = (db.prepare('SELECT id FROM card_import_batches WHERE card_account_id = ? ORDER BY rowid LIMIT 1')
      .get(seeded.chaseId) as { id: string }).id;
    const insert = db.prepare(`INSERT INTO card_transactions (id, card_account_id, source, external_id_hash, fingerprint,
        transaction_date, posted_date, status, amount_minor, currency, kind, description, import_batch_id, created_at, updated_at)
      VALUES (?, ?, 'chase-csv', ?, NULL, ?, ?, 'removed', ?, 'USD', 'purchase', ?, ?, ?, ?)`);
    const legacyRemovedIds = [`card-txn-${toLetterHex(randomBytes(16))}`, `card-txn-${toLetterHex(randomBytes(16))}`];
    insert.run(legacyRemovedIds[0], seeded.chaseId, cardExternalIdHash('CHASE-SYN-0003'), '2026-10-04', '2026-10-05', 777,
      'SYNTHETIC OUTSIDE TOOL', batch, CARD_TEST_T0, CARD_TEST_T0);
    insert.run(legacyRemovedIds[1], seeded.chaseId, cardExternalIdHash('CHASE-SYN-0004'), '2026-10-04', null, 999,
      'SYNTHETIC PREAUTH', batch, CARD_TEST_T0, CARD_TEST_T0);
    return { ...seeded, legacyRemovedIds };
  } finally {
    db.close();
  }
}

const SYNTHETIC_MERCHANTS = [
  'BLUE BOTTLE COFFEE', 'SYNTHETIC GROCERY MARKET', 'SYNTHETIC HARDWARE', 'SYNTHETIC AIRLINE', 'SYNTHETIC HOTEL',
  'SYNTHETIC BOOKS', 'SYNTHETIC PHARMACY', 'SYNTHETIC FUEL STATION', 'SYNTHETIC STREAMING', 'SYNTHETIC RESTAURANT',
  'SYNTHETIC CAFE PARIS', 'SYNTHETIC RIDE SHARE',
] as const;

/**
 * A v14 database with `rowCount` card transactions on two accounts, as years
 * of v1 imports leave it, for the migration's time budget (design §7.11 P9):
 * batches of up to 2,000 rows a month apart, every other one with a declared
 * coverage; references and fingerprints; posted, pending, dismissed and
 * legacy-removed rows; refunds, payments, foreign amounts, categories and
 * notes. The rows go in with v14's guards set aside, which then go back byte
 * for byte, as main's v14 build left them. Synthetic data only.
 */
export function writeLargeV14CardLedger(file: string, rowCount: number): { rows: number; batches: number } {
  const repo = new SqliteStateRepo({ file, now: () => new Date(CARD_TEST_T0) });
  const accounts = [
    repo.createCardAccount({ issuer: 'amex', owner: 'joint', nickname: 'Blue Cash', last4: '0003', currency: 'USD' }).id,
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' }).id,
  ];
  repo.close();
  downgradeCardSchema(file, 14);
  let state = 0x9e3779b9;
  const next = (n: number) => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % n;
  };
  const id = (prefix: string) => `${prefix}-${toLetterHex(randomBytes(16))}`;
  const day = (base: number, offset: number) => new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
  const db = withCardFunctions(new Database(file));
  let batches = 0;
  try {
    const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_card%_guard_%'")
      .all() as Array<{ name: string; sql: string }>;
    const insertBatch = db.prepare(`INSERT INTO card_import_batches (id, card_account_id, source, parser_version, row_count,
        new_count, duplicate_count, rejected_count, imported_at, coverage_start, coverage_end)
      VALUES (?, ?, ?, 'csv@1.0.0', ?, ?, 0, 0, ?, ?, ?)`);
    const insertRow = db.prepare(`INSERT INTO card_transactions (id, card_account_id, source, external_id_hash, fingerprint,
        transaction_date, posted_date, status, amount_minor, currency, original_amount_minor, original_currency, kind, description,
        merchant, issuer_category, user_category, notes, import_batch_id, created_at, updated_at, dismissed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const { name } of guards) db.exec(`DROP TRIGGER ${name}`);
      for (let start = 0; start < rowCount; start += 2000) {
        const n = Math.min(2000, rowCount - start);
        const month = start / 2000;
        const account = accounts[month % 2];
        const source = month % 2 === 0 ? 'amex-csv' : 'chase-csv';
        const first = Date.UTC(2022, 0, 1) + month * 30 * 86_400_000;
        const importedAt = new Date(first + 31 * 86_400_000).toISOString();
        const batchId = id('card-import');
        insertBatch.run(batchId, account, source, n, n, importedAt, month % 2 === 0 ? day(first, 0) : null,
          month % 2 === 0 ? day(first, 29) : null);
        batches += 1;
        for (let k = 0; k < n; k += 1) {
          const i = start + k;
          const merchant = SYNTHETIC_MERCHANTS[next(SYNTHETIC_MERCHANTS.length)];
          const transactionDate = day(first, next(28));
          const roll = next(100);
          const status = roll < 90 ? 'posted' : roll < 97 ? 'pending' : 'removed';
          const dismissed = status === 'removed' && roll === 97 ? importedAt : null;
          const kind = roll < 5 ? 'refund' : roll < 8 ? 'payment' : 'purchase';
          const amount = (kind === 'purchase' ? 1 : -1) * (100 + next(250_000));
          const foreign = merchant === 'SYNTHETIC CAFE PARIS';
          const description = `${merchant} ${String(1000 + next(9000)).slice(0, 3)}`;
          const reference = next(5) !== 0;
          insertRow.run(id('card-txn'), account, source,
            reference ? cardExternalIdHash(`SYN-${i}`) : null,
            reference ? null : cardTransactionFingerprint({ transactionDate, amountMinor: amount, description }, i),
            transactionDate, status === 'posted' || (status === 'removed' && !dismissed) ? day(Date.parse(transactionDate), 2) : null,
            status, amount, foreign ? Math.round(amount * 0.92) : null, foreign ? 'EUR' : null, kind, description,
            next(3) === 0 ? null : merchant, next(4) === 0 ? null : 'Shopping', next(20) === 0 ? 'Household' : null,
            next(50) === 0 ? 'synthetic note' : null, batchId, importedAt, importedAt, dismissed);
        }
      }
      for (const { sql } of guards) db.exec(sql);
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return { rows: rowCount, batches };
}
