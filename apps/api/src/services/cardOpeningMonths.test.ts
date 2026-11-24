import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cardOpeningEvidence } from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import {
  CARD_OPENING_MONTHS_NOT_INSTALLED,
  CARD_OPENING_MONTHS_REFUSED as MESSAGES,
  CARD_OPENING_MONTHS_SCHEMA_DIGEST,
  CARD_OPENING_MONTHS_SCHEMA_SQL,
  MAX_CARD_OPENING_MONTHS,
  cardOpeningMonthsInForce,
  cardOpeningMonthsSchemaState,
  clearCardOpeningMonth,
  confirmCardOpeningMonths as confirmStored,
  hasCardOpeningMonthsSchema,
  installCardOpeningMonthsSchema,
  isCardOpeningMonthsNotInstalled,
  listCardOpeningMonths,
  type CardFirstKnownDays,
} from './cardOpeningMonths.js';
import { HoldrDbError, HoldrRefusal, toValueFreeDbError, withValueFreeDbErrors } from './dbErrors.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

// Synthetic only: made-up card account ids, actor refs, rows, months and times.
const OWNER = `usr_${'abcdefghijklmnop'.repeat(2)}`;
const OTHER_OWNER = `usr_${'ponmlkjihgfedcba'.repeat(2)}`;
const CARD_A = `card-acct-${'a'.repeat(32)}`;
const CARD_B = `card-acct-${'b'.repeat(32)}`;
const CARD_C = `card-acct-${'c'.repeat(32)}`;
const CARD_D = `card-acct-${'d'.repeat(32)}`;
const UNKNOWN_CARD = `card-acct-${'p'.repeat(32)}`;
const T1 = '2026-10-01T09:00:00.000Z';
const T2 = '2026-10-02T09:00:00.000Z';
const T3 = '2026-10-03T09:00:00.000Z';
const MARKER = 'SYNTHETIC-MARKER-4111';

/** The design's table, kept apart from the code so a change to either fails here (and changes the GO's digest). */
const DESIGNED_SQL = `CREATE TABLE card_opening_months (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'com_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id TEXT NOT NULL CHECK (typeof(card_account_id) = 'text' AND length(CAST(card_account_id AS BLOB)) BETWEEN 1 AND 64 AND length(card_account_id) = length(CAST(card_account_id AS BLOB)) AND card_account_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  opening_month TEXT NOT NULL CHECK (typeof(opening_month) = 'text' AND length(CAST(opening_month AS BLOB)) = 7 AND opening_month GLOB '[12][0-9][0-9][0-9]-[01][0-9]' AND opening_month BETWEEN '1900-01' AND '2099-12' AND substr(opening_month, 6, 2) BETWEEN '01' AND '12'),
  confirmed_at TEXT NOT NULL CHECK (typeof(confirmed_at) = 'text' AND length(CAST(confirmed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS confirmed_at),
  confirmed_by TEXT NOT NULL CHECK (typeof(confirmed_by) = 'text' AND length(CAST(confirmed_by AS BLOB)) = 36 AND substr(confirmed_by, 1, 4) = 'usr_' AND substr(confirmed_by, 5) NOT GLOB '*[^a-p]*'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  revoked_by TEXT CHECK (revoked_by IS NULL OR (typeof(revoked_by) = 'text' AND length(CAST(revoked_by AS BLOB)) = 36 AND substr(revoked_by, 1, 4) = 'usr_' AND substr(revoked_by, 5) NOT GLOB '*[^a-p]*')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
)`;
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');

/** Only the columns the store reads of the card tables, with synthetic cards, rows and declared coverage. */
const CARD_TABLES_SQL = `CREATE TABLE card_accounts (id TEXT PRIMARY KEY);
  CREATE TABLE card_transactions (id TEXT PRIMARY KEY, card_account_id TEXT NOT NULL, transaction_date TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE card_import_batches (id TEXT PRIMARY KEY, card_account_id TEXT NOT NULL, coverage_start TEXT, coverage_end TEXT);
  INSERT INTO card_accounts VALUES ('${CARD_A}'), ('${CARD_B}'), ('${CARD_C}'), ('${CARD_D}');
  INSERT INTO card_transactions VALUES ('t1', '${CARD_A}', '2024-03-12', 'posted'), ('t2', '${CARD_A}', '2024-02-27', 'removed'),
    ('t3', '${CARD_B}', '2025-07-01', 'pending'), ('t4', '${CARD_B}', '2025-08-09', 'posted'), ('t5', '${CARD_D}', '2026-01-08', 'posted');
  INSERT INTO card_import_batches VALUES ('b1', '${CARD_A}', NULL, NULL), ('b2', '${CARD_D}', '2025-11-20', '2026-01-31'),
    ('b3', '${CARD_D}', '2026-02-01', '2026-03-31')`;

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(CARD_TABLES_SQL);
  askedInTransaction = [];
});
afterEach(() => { if (db.open) db.close(); });

const schemaOf = (target = db) => ({
  objects: target.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
  version: target.pragma('schema_version', { simple: true }),
});
const changes = (target = db) => target.prepare('SELECT total_changes()').pluck().get();
const stored = () => db.prepare(`SELECT card_account_id, opening_month, confirmed_at, confirmed_by, revoked_at, revoked_by
  FROM card_opening_months ORDER BY confirmed_at, opening_month`).all();
const ctx = (now = T1, actorRef = OWNER) => ({ actorRef, now });
/** Whether the store asked for the first known days inside its write transaction, each time. */
let askedInTransaction: boolean[] = [];
/**
 * The read path's first known day over the synthetic tables (shared cardOpeningEvidence: non-removed rows and declared
 * coverage), plus `windows`: a day a sync window Holdr verified complete starts on, as coverage would read it.
 */
const firstKnownDays = (target: Database.Database, windows: ReadonlyMap<string, string> = new Map()): CardFirstKnownDays => (ids) => {
  askedInTransaction.push(target.inTransaction);
  const rows = target.prepare('SELECT card_account_id AS cardAccountId, transaction_date AS transactionDate, status FROM card_transactions')
    .all() as Array<{ cardAccountId: string; transactionDate: string; status: 'pending' | 'posted' | 'removed' }>;
  const declared = target.prepare(`SELECT card_account_id AS cardAccountId, coverage_start AS start, coverage_end AS end
    FROM card_import_batches WHERE coverage_start IS NOT NULL`).all() as Array<{ cardAccountId: string; start: string; end: string }>;
  const coverage = [...declared.map(({ cardAccountId, start, end }) => ({ cardAccountId, ranges: [{ start, end }] })),
    ...[...windows].map(([cardAccountId, start]) => ({ cardAccountId, ranges: [{ start, end: start }] }))];
  return new Map(cardOpeningEvidence({ cards: ids.map((id) => ({ id })), rows, coverage }).map((card) => [card.cardAccountId, card.firstKnownDate]));
};
/** The store's confirmation, given the read path's first known days as the route gives them. */
const confirmCardOpeningMonths = (target: Database.Database, input: unknown, context: unknown, windows?: ReadonlyMap<string, string>) =>
  confirmStored(target, input, context as never, firstKnownDays(target, windows));
const caught = (fn: () => unknown): Error => {
  try { fn(); } catch (error) { return error as Error; }
  throw new Error('expected an error');
};
/** One of Holdr's own untouched refusals: the value-free boundary passes it on as it is. */
const expectRefusal = (error: Error, message: string) => {
  expect(Object.getPrototypeOf(error)).toBe(HoldrRefusal.prototype);
  expect(error.message).toBe(message);
  expect(toValueFreeDbError('confirm card opening months', error)).toBe(error);
};
const expectNotInstalled = (error: Error) => {
  expectRefusal(error, CARD_OPENING_MONTHS_NOT_INSTALLED);
  expect(isCardOpeningMonthsNotInstalled(error)).toBe(true);
};

describe('card opening months schema', () => {
  it('is exactly the designed table, pinned by its digest', () => {
    expect(normalize(CARD_OPENING_MONTHS_SCHEMA_SQL)).toBe(normalize(DESIGNED_SQL));
    expect(CARD_OPENING_MONTHS_SCHEMA_DIGEST).toBe(digest(normalize(DESIGNED_SQL)));
    expect(CARD_OPENING_MONTHS_SCHEMA_DIGEST).toBe('84e0b6c527a1c06120756c749f46e1ca17e85c60bbd9dc3192c9d11a89656a50');
  });

  it('reads no months and creates nothing without the table', async () => {
    const before = schemaOf();
    const writes = changes();
    expect(cardOpeningMonthsSchemaState(db)).toBe('absent');
    expect(hasCardOpeningMonthsSchema(db)).toBe(false);
    expect(listCardOpeningMonths(db)).toEqual([]);
    expect(schemaOf()).toEqual(before);
    expect(changes()).toBe(writes);

    // On a read-only connection too: reads never write, with or without the table.
    const dir = await makeScratchDir('card-openings-');
    try {
      const file = path.join(dir, 'finance.db');
      const writer = new Database(file);
      writer.pragma('journal_mode = WAL');
      writer.exec(CARD_TABLES_SQL);
      const reader = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(cardOpeningMonthsSchemaState(reader)).toBe('absent');
        expect(listCardOpeningMonths(reader)).toEqual([]);
        installCardOpeningMonthsSchema(writer);
        expect(confirmCardOpeningMonths(writer, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx())).toEqual({ changed: 1, unchanged: 0 });
        expect(cardOpeningMonthsSchemaState(reader)).toBe('present');
        const listed = listCardOpeningMonths(reader);
        expect(listed.map((record) => [record.cardAccountId, record.openingMonth])).toEqual([[CARD_A, '2024-03']]);
        for (const write of [() => confirmCardOpeningMonths(reader, [{ cardAccountId: CARD_B, openingMonth: '2025-07' }], ctx()),
          () => clearCardOpeningMonth(reader, CARD_A, ctx(T2))]) {
          const error = caught(write);
          expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
          expect((error as HoldrDbError).code).toMatch(/^SQLITE_READONLY/);
        }
        expect(listCardOpeningMonths(reader)).toEqual(listed);
      } finally {
        reader.close();
        writer.close();
      }
    } finally {
      await removeScratchDir(dir);
    }
  });

  it('installs the table only when asked, once, inside the caller\'s transaction', () => {
    const before = schemaOf();
    expect(() => db.transaction(() => {
      installCardOpeningMonthsSchema(db);
      expect(cardOpeningMonthsSchemaState(db)).toBe('present');
      throw new Error('synthetic rollback');
    })()).toThrow('synthetic rollback');
    expect(schemaOf()).toEqual(before);

    installCardOpeningMonthsSchema(db);
    expect(cardOpeningMonthsSchemaState(db)).toBe('present');
    expect(hasCardOpeningMonthsSchema(db)).toBe(true);
    const installed = schemaOf();
    expect(installed.objects.filter((object) => !before.objects.some((old) => JSON.stringify(old) === JSON.stringify(object))))
      .toEqual([
        { type: 'index', name: 'sqlite_autoindex_card_opening_months_1', tbl_name: 'card_opening_months', sql: null },
        { type: 'table', name: 'card_opening_months', tbl_name: 'card_opening_months', sql: CARD_OPENING_MONTHS_SCHEMA_SQL },
      ]);
    installCardOpeningMonthsSchema(db);
    expect(schemaOf()).toEqual(installed);
    expect(listCardOpeningMonths(db)).toEqual([]);
  });

  it('accepts the designed table however its SQL is spaced', () => {
    for (const sql of [normalize(CARD_OPENING_MONTHS_SCHEMA_SQL), CARD_OPENING_MONTHS_SCHEMA_SQL.replace(/\n\s*/g, '\r\n\t\t')]) {
      const target = new Database(':memory:');
      try {
        target.exec(sql);
        expect(cardOpeningMonthsSchemaState(target)).toBe('present');
        const installed = schemaOf(target);
        installCardOpeningMonthsSchema(target);
        expect(schemaOf(target)).toEqual(installed);
      } finally {
        target.close();
      }
    }
  });

  it('holds any other object of that name as a conflict: never read, repaired or written', () => {
    const validRow = `INSERT INTO card_opening_months VALUES ('com_${'a'.repeat(32)}', '${CARD_A}', '2024-03', '${T1}', '${OWNER}', NULL, NULL)`;
    const conflicts: Array<[string, string]> = [
      ['another shape', "CREATE TABLE card_opening_months (id TEXT PRIMARY KEY); INSERT INTO card_opening_months VALUES ('com_synthetic')"],
      ['a weaker check', `${CARD_OPENING_MONTHS_SCHEMA_SQL.replace("BETWEEN '01' AND '12'", "BETWEEN '00' AND '19'")}; ${validRow}`],
      ['the name in capitals', `${CARD_OPENING_MONTHS_SCHEMA_SQL.replace('TABLE card_opening_months', 'TABLE CARD_OPENING_MONTHS')}; ${validRow}`],
      ['a view', 'CREATE VIEW card_opening_months AS SELECT id FROM card_accounts'],
      ['an index', 'CREATE INDEX card_opening_months ON card_accounts (id)'],
      ['a trigger beside the table', `${CARD_OPENING_MONTHS_SCHEMA_SQL}; ${validRow};
        CREATE TRIGGER card_opening_months AFTER INSERT ON card_accounts BEGIN SELECT 1; END`],
    ];
    for (const [name, sql] of conflicts) {
      const target = new Database(':memory:');
      try {
        target.exec(CARD_TABLES_SQL);
        target.exec(sql);
        const before = schemaOf(target);
        const writes = changes(target);
        expect(cardOpeningMonthsSchemaState(target), name).toBe('conflict');
        expect(hasCardOpeningMonthsSchema(target), name).toBe(false);
        expect(listCardOpeningMonths(target), name).toEqual([]);
        expectRefusal(caught(() => installCardOpeningMonthsSchema(target)), MESSAGES.conflict);
        expectNotInstalled(caught(() => confirmCardOpeningMonths(target, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx())));
        expectNotInstalled(caught(() => clearCardOpeningMonth(target, CARD_A, ctx())));
        expect(schemaOf(target), name).toEqual(before);
        expect(changes(target), name).toBe(writes);
      } finally {
        target.close();
      }
    }
  });
});

describe('card opening months', () => {
  it('refuses every write until the table is installed, before looking at it, with a refusal every boundary passes', () => {
    const before = schemaOf();
    expect(CARD_OPENING_MONTHS_NOT_INSTALLED).toBe('card opening months are not installed on this Holdr');
    const error = caught(() => confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx()));
    expectNotInstalled(error);
    expect(error.name).toBe('HoldrRefusal');
    expect(Object.isFrozen(error)).toBe(true);
    expect(Reflect.ownKeys(error).sort()).toEqual(['message', 'stack']);
    expect(String(error.stack)).toMatch(new RegExp(`^HoldrRefusal: ${CARD_OPENING_MONTHS_NOT_INSTALLED}\n`));
    // The repository's boundary (withValueFreeDbErrors) lets it through as it is, so a route can answer 409.
    const guarded = caught(withValueFreeDbErrors('confirm card opening months',
      () => confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx())));
    expectNotInstalled(guarded);
    for (const write of [
      () => clearCardOpeningMonth(db, CARD_A, ctx()),
      () => confirmCardOpeningMonths(db, MARKER, { actorRef: MARKER, now: MARKER } as never),
      () => clearCardOpeningMonth(db, MARKER, { actorRef: MARKER, now: MARKER }),
    ]) {
      expectNotInstalled(caught(write));
    }
    expect(schemaOf()).toEqual(before);
  });

  it('recognizes only its own not-installed refusal', () => {
    installCardOpeningMonthsSchema(db);
    const refused = caught(() => confirmCardOpeningMonths(db, [{ cardAccountId: UNKNOWN_CARD, openingMonth: '2024-03' }], ctx()));
    const hostile = new Proxy({}, {
      get: () => { throw new Error(MARKER); },
      getPrototypeOf: () => { throw new Error(MARKER); },
    });
    for (const other of [refused, new HoldrRefusal(MESSAGES.conflict), new Error(CARD_OPENING_MONTHS_NOT_INSTALLED),
      new HoldrDbError('confirm card opening months', 'SQLITE_BUSY'), { message: CARD_OPENING_MONTHS_NOT_INSTALLED },
      CARD_OPENING_MONTHS_NOT_INSTALLED, null, undefined, hostile]) {
      expect(isCardOpeningMonthsNotInstalled(other)).toBe(false);
    }
    expect(isCardOpeningMonthsNotInstalled(new HoldrRefusal(CARD_OPENING_MONTHS_NOT_INSTALLED))).toBe(true);
  });

  it('confirms months in one batch, keeps a month confirmed again, and ends the old month on a change', () => {
    installCardOpeningMonthsSchema(db);
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }, { cardAccountId: CARD_B, openingMonth: '2025-07' }],
      ctx(T1))).toEqual({ changed: 2, unchanged: 0 });
    const first = listCardOpeningMonths(db);
    expect(first).toHaveLength(2);
    for (const record of first) {
      expect(record).toEqual({ id: expect.stringMatching(/^com_[a-p]{32}$/), cardAccountId: record.cardAccountId,
        openingMonth: record.cardAccountId === CARD_A ? '2024-03' : '2025-07', confirmedAt: T1, revokedAt: null });
      expect(Object.keys(record)).toEqual(['id', 'cardAccountId', 'openingMonth', 'confirmedAt', 'revokedAt']);
    }
    expect(JSON.stringify(first)).not.toContain('usr_');
    expect(cardOpeningMonthsInForce(first)).toEqual(new Map([[CARD_A, '2024-03'], [CARD_B, '2025-07']]));

    // The same month again writes nothing; another month ends the one in force (kept, with who ended it) and adds it.
    const writes = changes();
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx(T2, OTHER_OWNER))).toEqual({ changed: 0, unchanged: 1 });
    expect(changes()).toBe(writes);
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_B, openingMonth: '2025-06' }, { cardAccountId: CARD_A, openingMonth: '2024-03' }],
      ctx(T2, OTHER_OWNER))).toEqual({ changed: 1, unchanged: 1 });
    expect(stored()).toEqual([
      { card_account_id: CARD_A, opening_month: '2024-03', confirmed_at: T1, confirmed_by: OWNER, revoked_at: null, revoked_by: null },
      { card_account_id: CARD_B, opening_month: '2025-07', confirmed_at: T1, confirmed_by: OWNER, revoked_at: T2, revoked_by: OTHER_OWNER },
      { card_account_id: CARD_B, opening_month: '2025-06', confirmed_at: T2, confirmed_by: OTHER_OWNER, revoked_at: null, revoked_by: null },
    ]);
    const listed = listCardOpeningMonths(db);
    // Oldest first, and in the order written within one instant.
    expect(listed.map((record) => [record.cardAccountId, record.openingMonth, record.confirmedAt, record.revokedAt])).toEqual([
      [CARD_A, '2024-03', T1, null], [CARD_B, '2025-07', T1, T2], [CARD_B, '2025-06', T2, null],
    ]);
    expect(cardOpeningMonthsInForce(listed)).toEqual(new Map([[CARD_A, '2024-03'], [CARD_B, '2025-06']]));
  });

  it('clears a month once, keeping it: false when none is in force, null for a card that is not here', () => {
    installCardOpeningMonthsSchema(db);
    confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx(T1));
    expect(clearCardOpeningMonth(db, CARD_A, ctx(T2, OTHER_OWNER))).toBe(true);
    const writes = changes();
    expect(clearCardOpeningMonth(db, CARD_A, ctx(T3))).toBe(false);
    expect(clearCardOpeningMonth(db, CARD_C, ctx(T3))).toBe(false);
    expect(clearCardOpeningMonth(db, UNKNOWN_CARD, ctx(T3))).toBeNull();
    expect(changes()).toBe(writes);
    expect(stored()).toEqual([
      { card_account_id: CARD_A, opening_month: '2024-03', confirmed_at: T1, confirmed_by: OWNER, revoked_at: T2, revoked_by: OTHER_OWNER },
    ]);
    expect(cardOpeningMonthsInForce(listCardOpeningMonths(db))).toEqual(new Map());
    // Confirmed again after a clear: a new confirmation, the cleared one kept.
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx(T3))).toEqual({ changed: 1, unchanged: 0 });
    expect(listCardOpeningMonths(db).map((record) => [record.openingMonth, record.confirmedAt, record.revokedAt]))
      .toEqual([['2024-03', T1, T2], ['2024-03', T3, null]]);
  });

  it('refuses a month later than the card\'s first known day, after this month, or for a card that is not here: all or nothing', () => {
    installCardOpeningMonthsSchema(db);
    const writes = changes();
    expect(MESSAGES.contradicted).toBe('openingMonth must not be after the month of the first day Holdr has for the card');
    const cases: Array<[Array<{ cardAccountId: unknown; openingMonth: unknown }>, string, string, Map<string, string>?]> = [
      // CARD_A's first stored row is on 2024-03-12 (the removed one in February is no evidence).
      [[{ cardAccountId: CARD_A, openingMonth: '2024-04' }], ctx().now, MESSAGES.contradicted],
      // A pending row is a stored row too.
      [[{ cardAccountId: CARD_C, openingMonth: '2020-01' }, { cardAccountId: CARD_B, openingMonth: '2025-08' }], ctx().now, MESSAGES.contradicted],
      // CARD_D's imports declare its record from 2025-11-20, before its first row in January: evidence already exists then.
      [[{ cardAccountId: CARD_D, openingMonth: '2026-01' }], ctx().now, MESSAGES.contradicted],
      [[{ cardAccountId: CARD_D, openingMonth: '2025-12' }], ctx().now, MESSAGES.contradicted],
      // A sync window Holdr verified complete, as coverage reads it: CARD_C, without rows or imports, is known from February.
      [[{ cardAccountId: CARD_C, openingMonth: '2026-03' }], ctx().now, MESSAGES.contradicted, new Map([[CARD_C, '2026-02-03']])],
      [[{ cardAccountId: CARD_C, openingMonth: '2026-11' }], T1, MESSAGES.future],
      [[{ cardAccountId: CARD_A, openingMonth: '2024-03' }, { cardAccountId: UNKNOWN_CARD, openingMonth: '2024-03' }], T1, MESSAGES.card],
    ];
    for (const [entries, now, message, windows] of cases) {
      const error = caught(() => confirmCardOpeningMonths(db, entries, ctx(now), windows));
      expectRefusal(error, message);
      expect(error.message).not.toMatch(/20\d\d-/);
    }
    expect(changes()).toBe(writes);
    expect(listCardOpeningMonths(db)).toEqual([]);
    // Asked once per change that got that far, inside the write transaction, under its lock.
    expect(askedInTransaction.length).toBeGreaterThanOrEqual(5);
    expect(askedInTransaction.every(Boolean)).toBe(true);
    // The month of the first known day itself and any earlier month are fine, and this month for a card without data.
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-02' }, { cardAccountId: CARD_B, openingMonth: '2025-07' },
      { cardAccountId: CARD_C, openingMonth: '2026-10' }, { cardAccountId: CARD_D, openingMonth: '2025-11' }], ctx(T1))).toEqual({ changed: 4, unchanged: 0 });
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_C, openingMonth: '2026-02' }], ctx(T2), new Map([[CARD_C, '2026-02-03']])))
      .toEqual({ changed: 1, unchanged: 0 });
    // Only the read path's days count: a value that is not a day is no evidence, and the store reads nothing else.
    let asked: readonly string[] = [];
    expect(confirmStored(db, [{ cardAccountId: CARD_A, openingMonth: '2024-05' }, { cardAccountId: CARD_D, openingMonth: '2026-03' }], ctx(T3),
      (ids) => { asked = ids; return new Map([[CARD_A, 'not-a-day'], [CARD_D, null]]); })).toEqual({ changed: 2, unchanged: 0 });
    expect(asked).toEqual([CARD_A, CARD_D]);
  });

  it('refuses invalid input with a fixed message that never repeats it, writing nothing', () => {
    installCardOpeningMonthsSchema(db);
    confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx(T1));
    const existing = listCardOpeningMonths(db);
    const writes = changes();
    const valid = { cardAccountId: CARD_B, openingMonth: '2025-07' };
    const cases: Array<[unknown, unknown, string]> = [
      ...[null, undefined, 42, MARKER, {}, [], Array.from({ length: MAX_CARD_OPENING_MONTHS + 1 }, () => valid), [null], [MARKER]]
        .map((input): [unknown, unknown, string] => [input, ctx(T2), MESSAGES.input]),
      ...[undefined, null, '', 42, 'card acct', 'x'.repeat(65), `${CARD_B}\u0000`, `${CARD_B} `, MARKER.replace(/-/g, '/')]
        .map((value): [unknown, unknown, string] => [[{ ...valid, cardAccountId: value }], ctx(T2), MESSAGES.card]),
      [[valid, { ...valid, openingMonth: '2025-06' }], ctx(T2), MESSAGES.duplicate],
      ...[undefined, null, '', '2025-7', '2025-13', '2025-00', '1899-12', '2100-01', '2025-07-01', ' 2025-07', 202507, MARKER]
        .map((value): [unknown, unknown, string] => [[{ ...valid, openingMonth: value }], ctx(T2), MESSAGES.month]),
      ...[undefined, null, '', `usr_${'a'.repeat(31)}`, `usr_${'q'.repeat(32)}`, `USR_${'a'.repeat(32)}`, `${OWNER} `, 42, MARKER]
        .map((value): [unknown, unknown, string] => [[valid], { actorRef: value, now: T2 }, MESSAGES.actor]),
      [[valid], null, MESSAGES.actor],
      ...[undefined, null, '', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00.000+00:00', '2026-02-30T09:00:00.000Z',
        '2026-10-02 09:00:00.000Z', '2026-13-02T09:00:00.000Z', Date.parse(T2), new Date(T2), MARKER]
        .map((value): [unknown, unknown, string] => [[valid], { actorRef: OWNER, now: value }, MESSAGES.now]),
    ];
    for (const [input, context, message] of cases) {
      const error = caught(() => confirmCardOpeningMonths(db, input, context as never));
      expectRefusal(error, message);
      expect(error.message).not.toContain('SYNTHETIC');
    }
    for (const id of [undefined, null, '', 42, {}, 'card acct', `${CARD_A} `, MARKER.replace(/-/g, '/')]) {
      expectRefusal(caught(() => clearCardOpeningMonth(db, id, ctx(T2))), MESSAGES.card);
    }
    for (const [context, message] of [[null, MESSAGES.actor], [{ actorRef: MARKER, now: T2 }, MESSAGES.actor],
      [{ actorRef: OWNER, now: MARKER }, MESSAGES.now]] as Array<[unknown, string]>) {
      expectRefusal(caught(() => clearCardOpeningMonth(db, CARD_A, context as never)), message);
    }
    expect(changes()).toBe(writes);
    expect(listCardOpeningMonths(db)).toEqual(existing);
  });

  it('has the table refuse rows written around the store', () => {
    installCardOpeningMonthsSchema(db);
    const valid: Record<string, unknown> = { id: `com_${'a'.repeat(32)}`, card_account_id: CARD_A, opening_month: '2024-03',
      confirmed_at: T1, confirmed_by: OWNER, revoked_at: null, revoked_by: null };
    const insert = db.prepare(`INSERT INTO card_opening_months
      (id, card_account_id, opening_month, confirmed_at, confirmed_by, revoked_at, revoked_by)
      VALUES (@id, @card_account_id, @opening_month, @confirmed_at, @confirmed_by, @revoked_at, @revoked_by)`);
    const outcome = (patch: Record<string, unknown>) => {
      try {
        insert.run({ ...valid, ...patch });
        return 'inserted';
      } catch (error) {
        return (error as { code?: unknown }).code;
      }
    };
    const refusedByChecks: Array<[string, Record<string, unknown>]> = [
      ['id prefix', { id: `csr_${'a'.repeat(32)}` }], ['id length', { id: `com_${'a'.repeat(31)}` }],
      ['id letters', { id: `com_${'a'.repeat(31)}q` }], ['id capitals', { id: `com_${'A'.repeat(32)}` }],
      ['id blob', { id: Buffer.from(`com_${'a'.repeat(32)}`) }],
      ['card empty', { card_account_id: '' }], ['card too long', { card_account_id: 'c'.repeat(65) }],
      ['card space', { card_account_id: 'card acct' }], ['card slash', { card_account_id: 'card/acct' }],
      ['card after a NUL', { card_account_id: `${CARD_A}\u0000 x` }], ['card blob', { card_account_id: Buffer.from(CARD_A) }],
      ['card number', { card_account_id: 42 }],
      ['month short', { opening_month: '2024-3' }], ['month thirteen', { opening_month: '2024-13' }], ['month zero', { opening_month: '2024-00' }],
      ['month too early', { opening_month: '1899-12' }], ['month too late', { opening_month: '2100-01' }],
      ['month a day', { opening_month: '2024-03-01' }], ['month separator', { opening_month: '2024/03' }],
      ['confirmed_at without milliseconds', { confirmed_at: '2026-10-01T09:00:00Z' }],
      ['confirmed_at no such day', { confirmed_at: '2026-02-30T09:00:00.000Z' }],
      ['confirmed_by letters', { confirmed_by: `usr_${'q'.repeat(32)}` }], ['confirmed_by length', { confirmed_by: `usr_${'a'.repeat(31)}` }],
      ['revoked_at alone', { revoked_at: T2 }], ['revoked_by alone', { revoked_by: OWNER }],
      ['revoked_at format', { revoked_at: 'yesterday', revoked_by: OWNER }],
      ['revoked_by shape', { revoked_at: T2, revoked_by: `usr_${'a'.repeat(31)}` }],
    ];
    for (const [name, patch] of refusedByChecks) expect(outcome(patch), name).toBe('SQLITE_CONSTRAINT_CHECK');
    for (const column of ['id', 'card_account_id', 'opening_month', 'confirmed_at', 'confirmed_by']) {
      expect(outcome({ [column]: null }), column).toBe('SQLITE_CONSTRAINT_NOTNULL');
    }
    expect(listCardOpeningMonths(db)).toEqual([]);
    for (const [index, patch] of [{ card_account_id: 'A_b-9' }, { opening_month: '1900-01' }, { opening_month: '2099-12' },
      { revoked_at: T2, revoked_by: OTHER_OWNER }].entries()) {
      expect(outcome({ id: `com_${'bcde'[index].repeat(32)}`, ...patch }), JSON.stringify(patch)).toBe('inserted');
    }
    expect(outcome({ id: `com_${'b'.repeat(32)}` })).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
    expect(listCardOpeningMonths(db).map((record) => [record.cardAccountId, record.openingMonth, record.revokedAt])).toEqual(
      expect.arrayContaining([['A_b-9', '2024-03', null], [CARD_A, '1900-01', null], [CARD_A, '2099-12', null], [CARD_A, '2024-03', T2]]));
  });

  it('skips a row the checks should have refused, and keeps no month for a card with two in force', () => {
    installCardOpeningMonthsSchema(db);
    confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }, { cardAccountId: CARD_B, openingMonth: '2025-07' }], ctx(T1));
    const kept = listCardOpeningMonths(db);
    db.pragma('ignore_check_constraints = ON');
    db.prepare("INSERT INTO card_opening_months VALUES (?, ?, '2024-13', ?, ?, NULL, NULL)").run(`com_${'b'.repeat(32)}`, CARD_C, T1, OWNER);
    db.pragma('ignore_check_constraints = OFF');
    expect(listCardOpeningMonths(db)).toEqual(kept);
    // Written around the store: a second month in force for one card. Neither applies.
    db.prepare("INSERT INTO card_opening_months VALUES (?, ?, '2024-01', ?, ?, NULL, NULL)").run(`com_${'c'.repeat(32)}`, CARD_A, T2, OWNER);
    expect(cardOpeningMonthsInForce(listCardOpeningMonths(db))).toEqual(new Map([[CARD_B, '2025-07']]));
    // A change or a clear ends both.
    expect(confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-02' }], ctx(T3))).toEqual({ changed: 1, unchanged: 0 });
    expect(cardOpeningMonthsInForce(listCardOpeningMonths(db))).toEqual(new Map([[CARD_A, '2024-02'], [CARD_B, '2025-07']]));
  });

  it('turns a database failure into a value-free error', () => {
    installCardOpeningMonthsSchema(db);
    db.close();
    for (const operation of [
      () => cardOpeningMonthsSchemaState(db),
      () => hasCardOpeningMonthsSchema(db),
      () => installCardOpeningMonthsSchema(db),
      () => listCardOpeningMonths(db),
      () => confirmCardOpeningMonths(db, [{ cardAccountId: CARD_A, openingMonth: '2024-03' }], ctx(T2)),
      () => clearCardOpeningMonth(db, CARD_A, ctx(T2)),
    ]) {
      const error = caught(operation);
      expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
      expect(error.message).toMatch(/^(read card opening months schema|[a-z ]+ card opening months?) failed \(UNKNOWN\)$/);
    }
  });
});
