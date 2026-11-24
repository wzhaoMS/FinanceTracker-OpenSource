import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CARD_ASSET_CATEGORY, CARD_METALS_MERCHANT_CLASSES } from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import {
  CARD_SPENDING_RULES_NOT_INSTALLED,
  CARD_SPENDING_RULES_SCHEMA_DIGEST,
  CARD_SPENDING_RULES_SCHEMA_SQL,
  cardSpendingRulesSchemaState,
  createCardSpendingRule,
  hasCardSpendingRulesSchema,
  installCardSpendingRulesSchema,
  isCardSpendingRulesNotInstalled,
  listCardSpendingRules,
  revokeCardSpendingRule,
} from './cardSpendingRules.js';
import { HoldrDbError, HoldrRefusal, toValueFreeDbError, withValueFreeDbErrors } from './dbErrors.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

// Synthetic only: made-up actor refs, rule ids, amounts and times.
const OWNER = `usr_${'abcdefghijklmnop'.repeat(2)}`;
const OTHER_OWNER = `usr_${'ponmlkjihgfedcba'.repeat(2)}`;
const UNKNOWN_RULE = `csr_${'p'.repeat(32)}`;
const T1 = '2026-10-01T09:00:00.000Z';
const T2 = '2026-10-02T09:00:00.000Z';
const T3 = '2026-10-03T09:00:00.000Z';
const MARKER = 'SYNTHETIC-MARKER-4111';

/** The design's table, kept apart from the code so a change to either fails here (and changes the GO's digest). */
const DESIGNED_SQL = `CREATE TABLE card_spending_rules (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'csr_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  reason TEXT NOT NULL CHECK (reason = 'asset-purchase'),
  category TEXT NOT NULL CHECK (category = 'Precious metals'),
  merchant_class TEXT NOT NULL CHECK (merchant_class IN ('bullion-dealer', 'costco-online', 'walmart-online', 'sams-club', 'costco-warehouse')),
  currency TEXT NOT NULL CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  min_amount_minor INTEGER NOT NULL CHECK (typeof(min_amount_minor) = 'integer' AND min_amount_minor BETWEEN 1 AND 999999999999),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  created_by TEXT NOT NULL CHECK (typeof(created_by) = 'text' AND length(CAST(created_by AS BLOB)) = 36 AND substr(created_by, 1, 4) = 'usr_' AND substr(created_by, 5) NOT GLOB '*[^a-p]*'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  revoked_by TEXT CHECK (revoked_by IS NULL OR (typeof(revoked_by) = 'text' AND length(CAST(revoked_by AS BLOB)) = 36 AND substr(revoked_by, 1, 4) = 'usr_' AND substr(revoked_by, 5) NOT GLOB '*[^a-p]*')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
)`;
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');

const MESSAGES = {
  conflict: 'card_spending_rules already exists in another shape; nothing was installed',
  input: 'an owner rule must be an object',
  merchantClass: 'merchantClass must be one of bullion-dealer, costco-online, walmart-online, sams-club, costco-warehouse',
  currency: 'currency must be three capital letters',
  minAmountMinor: 'minAmountMinor must be a whole number of minor units from 1 to 999999999999',
  id: 'id must be an owner rule id',
  actor: 'an owner rule change needs the acting owner',
  now: 'an owner rule change needs its time as an ISO instant',
  duplicate: 'an owner rule like this one is already in force',
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec("CREATE TABLE synthetic_ledger (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO synthetic_ledger (note) VALUES ('synthetic')");
});
afterEach(() => { if (db.open) db.close(); });

const schemaOf = (target = db) => ({
  objects: target.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
  version: target.pragma('schema_version', { simple: true }),
});
const changes = (target = db) => target.prepare('SELECT total_changes()').pluck().get();
const stored = (id: string) => db.prepare('SELECT created_by, revoked_at, revoked_by FROM card_spending_rules WHERE id = ?').get(id);
const ctx = (now = T1, actorRef = OWNER) => ({ actorRef, now });
const rule = (patch: Record<string, unknown> = {}) => ({ merchantClass: 'costco-online', currency: 'USD', minAmountMinor: 100_000, ...patch });
const caught = (fn: () => unknown): Error => {
  try { fn(); } catch (error) { return error as Error; }
  throw new Error('expected an error');
};
/** One of Holdr's own untouched refusals: the value-free boundary passes it on as it is. */
const expectRefusal = (error: Error, message: string) => {
  expect(Object.getPrototypeOf(error)).toBe(HoldrRefusal.prototype);
  expect(error.message).toBe(message);
  expect(toValueFreeDbError('create owner spending rule', error)).toBe(error);
};
const expectNotInstalled = (error: Error) => {
  expectRefusal(error, CARD_SPENDING_RULES_NOT_INSTALLED);
  expect(isCardSpendingRulesNotInstalled(error)).toBe(true);
};

describe('owner spending rules schema', () => {
  it('is exactly the designed table, pinned by its digest', () => {
    expect(normalize(CARD_SPENDING_RULES_SCHEMA_SQL)).toBe(normalize(DESIGNED_SQL));
    expect(CARD_SPENDING_RULES_SCHEMA_DIGEST).toBe(digest(normalize(DESIGNED_SQL)));
    expect(CARD_SPENDING_RULES_SCHEMA_DIGEST).toBe('dad4694477676b9749a338c3ac2046205e9b27a2837c6b0ba6f8b6411cf1a81c');
    const classes = /merchant_class IN \(([^)]*)\)/.exec(CARD_SPENDING_RULES_SCHEMA_SQL)![1]
      .split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1'));
    expect(classes).toEqual([...CARD_METALS_MERCHANT_CLASSES]);
    expect(/category = '([^']*)'/.exec(CARD_SPENDING_RULES_SCHEMA_SQL)![1]).toBe(CARD_ASSET_CATEGORY);
  });

  it('reads no rules and creates nothing without the table', async () => {
    const before = schemaOf();
    const writes = changes();
    expect(cardSpendingRulesSchemaState(db)).toBe('absent');
    expect(hasCardSpendingRulesSchema(db)).toBe(false);
    expect(listCardSpendingRules(db)).toEqual([]);
    expect(schemaOf()).toEqual(before);
    expect(changes()).toBe(writes);

    // On a read-only connection too: reads never write, with or without the table.
    const dir = await makeScratchDir('spending-rules-');
    try {
      const file = path.join(dir, 'finance.db');
      const writer = new Database(file);
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE synthetic_ledger (note TEXT)');
      const reader = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(cardSpendingRulesSchemaState(reader)).toBe('absent');
        expect(listCardSpendingRules(reader)).toEqual([]);
        installCardSpendingRulesSchema(writer);
        const created = createCardSpendingRule(writer, rule(), ctx());
        expect(cardSpendingRulesSchemaState(reader)).toBe('present');
        expect(listCardSpendingRules(reader)).toEqual([created]);
        for (const write of [() => createCardSpendingRule(reader, rule({ currency: 'EUR' }), ctx()),
          () => revokeCardSpendingRule(reader, created.id, ctx(T2))]) {
          const error = caught(write);
          expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
          expect((error as HoldrDbError).code).toMatch(/^SQLITE_READONLY/);
        }
        expect(listCardSpendingRules(reader)).toEqual([created]);
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
      installCardSpendingRulesSchema(db);
      expect(cardSpendingRulesSchemaState(db)).toBe('present');
      throw new Error('synthetic rollback');
    })()).toThrow('synthetic rollback');
    expect(schemaOf()).toEqual(before);

    installCardSpendingRulesSchema(db);
    expect(cardSpendingRulesSchemaState(db)).toBe('present');
    expect(hasCardSpendingRulesSchema(db)).toBe(true);
    const installed = schemaOf();
    expect(installed.objects.filter((object) => !before.objects.some((old) => JSON.stringify(old) === JSON.stringify(object))))
      .toEqual([
        { type: 'index', name: 'sqlite_autoindex_card_spending_rules_1', tbl_name: 'card_spending_rules', sql: null },
        { type: 'table', name: 'card_spending_rules', tbl_name: 'card_spending_rules', sql: CARD_SPENDING_RULES_SCHEMA_SQL },
      ]);
    installCardSpendingRulesSchema(db);
    expect(schemaOf()).toEqual(installed);
    expect(listCardSpendingRules(db)).toEqual([]);
  });

  it('accepts the designed table however its SQL is spaced', () => {
    for (const sql of [normalize(CARD_SPENDING_RULES_SCHEMA_SQL), CARD_SPENDING_RULES_SCHEMA_SQL.replace(/\n\s*/g, '\r\n\t\t')]) {
      const target = new Database(':memory:');
      try {
        target.exec(sql);
        expect(cardSpendingRulesSchemaState(target)).toBe('present');
        const installed = schemaOf(target);
        installCardSpendingRulesSchema(target);
        expect(schemaOf(target)).toEqual(installed);
      } finally {
        target.close();
      }
    }
  });

  it('holds any other object of that name as a conflict: never read, repaired or written', () => {
    const validRow = `INSERT INTO card_spending_rules VALUES ('csr_${'a'.repeat(32)}', 'asset-purchase', 'Precious metals',
      'costco-online', 'USD', 100000, '${T1}', '${OWNER}', NULL, NULL)`;
    const conflicts: Array<[string, string]> = [
      ['another shape', "CREATE TABLE card_spending_rules (id TEXT PRIMARY KEY); INSERT INTO card_spending_rules VALUES ('csr_synthetic')"],
      ['a weaker check', `${CARD_SPENDING_RULES_SCHEMA_SQL.replace('BETWEEN 1 AND', 'BETWEEN 0 AND')}; ${validRow}`],
      ['the name in capitals', `${CARD_SPENDING_RULES_SCHEMA_SQL.replace('TABLE card_spending_rules', 'TABLE CARD_SPENDING_RULES')}; ${validRow}`],
      ['a view', 'CREATE VIEW card_spending_rules AS SELECT note FROM synthetic_ledger'],
      ['an index', 'CREATE INDEX card_spending_rules ON synthetic_ledger (note)'],
      ['a trigger beside the table', `${CARD_SPENDING_RULES_SCHEMA_SQL}; ${validRow};
        CREATE TRIGGER card_spending_rules AFTER INSERT ON synthetic_ledger BEGIN SELECT 1; END`],
    ];
    for (const [name, sql] of conflicts) {
      const target = new Database(':memory:');
      try {
        target.exec('CREATE TABLE synthetic_ledger (id INTEGER PRIMARY KEY, note TEXT)');
        target.exec(sql);
        const before = schemaOf(target);
        const writes = changes(target);
        expect(cardSpendingRulesSchemaState(target), name).toBe('conflict');
        expect(hasCardSpendingRulesSchema(target), name).toBe(false);
        expect(listCardSpendingRules(target), name).toEqual([]);
        expectRefusal(caught(() => installCardSpendingRulesSchema(target)), MESSAGES.conflict);
        expectNotInstalled(caught(() => createCardSpendingRule(target, rule(), ctx())));
        expectNotInstalled(caught(() => revokeCardSpendingRule(target, `csr_${'a'.repeat(32)}`, ctx())));
        expect(schemaOf(target), name).toEqual(before);
        expect(changes(target), name).toBe(writes);
      } finally {
        target.close();
      }
    }
  });
});

describe('owner spending rules', () => {
  it('refuses every write until the table is installed, before looking at it, with a refusal every boundary passes', () => {
    const before = schemaOf();
    expect(CARD_SPENDING_RULES_NOT_INSTALLED).toBe('owner spending rules are not installed on this Holdr');
    const error = caught(() => createCardSpendingRule(db, rule(), ctx()));
    expectNotInstalled(error);
    expect(error.name).toBe('HoldrRefusal');
    expect(Object.isFrozen(error)).toBe(true);
    expect(Reflect.ownKeys(error).sort()).toEqual(['message', 'stack']);
    expect(String(error.stack)).toMatch(new RegExp(`^HoldrRefusal: ${CARD_SPENDING_RULES_NOT_INSTALLED}\n`));
    // The repository's boundary (withValueFreeDbErrors) lets it through as it is, so a route can answer 409.
    const guarded = caught(withValueFreeDbErrors('create owner spending rule', () => createCardSpendingRule(db, rule(), ctx())));
    expectNotInstalled(guarded);
    for (const write of [
      () => revokeCardSpendingRule(db, UNKNOWN_RULE, ctx()),
      () => createCardSpendingRule(db, { merchantClass: MARKER, currency: MARKER, minAmountMinor: MARKER }, ctx()),
      () => revokeCardSpendingRule(db, MARKER, { actorRef: MARKER, now: MARKER }),
    ]) {
      expectNotInstalled(caught(write));
    }
    expect(schemaOf()).toEqual(before);
  });

  it('recognizes only its own not-installed refusal', () => {
    installCardSpendingRulesSchema(db);
    createCardSpendingRule(db, rule(), ctx());
    const duplicate = caught(() => createCardSpendingRule(db, rule(), ctx(T2)));
    const hostile = new Proxy({}, {
      get: () => { throw new Error(MARKER); },
      getPrototypeOf: () => { throw new Error(MARKER); },
    });
    for (const other of [duplicate, new HoldrRefusal(MESSAGES.conflict), new Error(CARD_SPENDING_RULES_NOT_INSTALLED),
      new HoldrDbError('create owner spending rule', 'SQLITE_BUSY'), { message: CARD_SPENDING_RULES_NOT_INSTALLED },
      CARD_SPENDING_RULES_NOT_INSTALLED, null, undefined, hostile]) {
      expect(isCardSpendingRulesNotInstalled(other)).toBe(false);
    }
    expect(isCardSpendingRulesNotInstalled(new HoldrRefusal(CARD_SPENDING_RULES_NOT_INSTALLED))).toBe(true);
  });

  it('creates, lists (oldest first, then by id) and revokes rules, without actor refs', () => {
    installCardSpendingRulesSchema(db);
    const later = createCardSpendingRule(db, rule({ merchantClass: 'bullion-dealer', minAmountMinor: 1 }), ctx(T2));
    const first = createCardSpendingRule(db, rule(), ctx(T1));
    const sameTime = createCardSpendingRule(db, rule({ merchantClass: 'sams-club', currency: 'CAD', minAmountMinor: 999_999_999_999 }),
      ctx(T1, OTHER_OWNER));
    expect(first).toEqual({ id: expect.stringMatching(/^csr_[a-p]{32}$/), reason: 'asset-purchase', category: CARD_ASSET_CATEGORY,
      merchantClass: 'costco-online', currency: 'USD', minAmountMinor: 100_000, createdAt: T1, revokedAt: null });
    expect(Object.keys(first)).toEqual(['id', 'reason', 'category', 'merchantClass', 'currency', 'minAmountMinor', 'createdAt', 'revokedAt']);
    expect(new Set([first.id, later.id, sameTime.id]).size).toBe(3);
    const atT1 = [first, sameTime].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(listCardSpendingRules(db)).toEqual([...atT1, later]);
    expect(stored(first.id)).toEqual({ created_by: OWNER, revoked_at: null, revoked_by: null });
    expect(stored(sameTime.id)).toEqual({ created_by: OTHER_OWNER, revoked_at: null, revoked_by: null });
    expect(JSON.stringify(listCardSpendingRules(db))).not.toContain('usr_');

    const revoked = revokeCardSpendingRule(db, first.id, ctx(T3, OTHER_OWNER));
    expect(revoked).toEqual({ ...first, revokedAt: T3 });
    expect(stored(first.id)).toEqual({ created_by: OWNER, revoked_at: T3, revoked_by: OTHER_OWNER });
    expect(listCardSpendingRules(db)).toEqual([...atT1.map((item) => (item.id === first.id ? revoked : item)), later]);
    expect(JSON.stringify(revoked)).not.toContain('usr_');
  });

  it('refuses a rule exactly like one in force, never one like a revoked rule', () => {
    installCardSpendingRulesSchema(db);
    const kept = createCardSpendingRule(db, rule(), ctx(T1));
    const writes = changes();
    expectRefusal(caught(() => createCardSpendingRule(db, rule(), ctx(T2, OTHER_OWNER))), MESSAGES.duplicate);
    expect(changes()).toBe(writes);
    // Another class, currency or amount is another rule.
    for (const patch of [{ merchantClass: 'walmart-online' }, { currency: 'EUR' }, { minAmountMinor: 100_001 }]) {
      createCardSpendingRule(db, rule(patch), ctx(T2));
    }
    revokeCardSpendingRule(db, kept.id, ctx(T2));
    const again = createCardSpendingRule(db, rule(), ctx(T3));
    expect(again.id).not.toBe(kept.id);
    expect(listCardSpendingRules(db).filter((item) => item.merchantClass === 'costco-online' && item.currency === 'USD'
      && item.minAmountMinor === 100_000).map((item) => [item.id, item.revokedAt])).toEqual([[kept.id, T2], [again.id, null]]);
  });

  it('revokes a rule once; a revoked rule comes back unchanged and an unknown one as null', () => {
    installCardSpendingRulesSchema(db);
    const created = createCardSpendingRule(db, rule(), ctx(T1));
    const revoked = revokeCardSpendingRule(db, created.id, ctx(T2));
    expect(revoked).toEqual({ ...created, revokedAt: T2 });
    const writes = changes();
    expect(revokeCardSpendingRule(db, created.id, ctx(T3, OTHER_OWNER))).toEqual(revoked);
    expect(stored(created.id)).toEqual({ created_by: OWNER, revoked_at: T2, revoked_by: OWNER });
    expect(revokeCardSpendingRule(db, UNKNOWN_RULE, ctx(T3))).toBeNull();
    expect(changes()).toBe(writes);
    expect(listCardSpendingRules(db)).toEqual([revoked]);
  });

  it('refuses invalid input with a fixed message that never repeats it, writing nothing', () => {
    installCardSpendingRulesSchema(db);
    const existing = createCardSpendingRule(db, rule(), ctx(T1));
    const writes = changes();
    const fresh = rule({ minAmountMinor: 100_001 });
    const cases: Array<[unknown, unknown, string]> = [
      ...[null, undefined, 42, MARKER].map((input): [unknown, unknown, string] => [input, ctx(T2), MESSAGES.input]),
      ...[undefined, null, '', 'costco', 'COSTCO-ONLINE', 'costco online', ' costco-online', 1, {}, ['costco-online'], MARKER]
        .map((value): [unknown, unknown, string] => [rule({ merchantClass: value }), ctx(T2), MESSAGES.merchantClass]),
      ...[undefined, null, '', 'usd', 'US', 'USDX', 'U$D', '\u00dcSD', 840, MARKER]
        .map((value): [unknown, unknown, string] => [rule({ currency: value }), ctx(T2), MESSAGES.currency]),
      ...[undefined, null, 0, -1, 1.5, '100000', Number.NaN, Infinity, 1_000_000_000_000, Number.MAX_SAFE_INTEGER, 2 ** 53, 100_000n, MARKER]
        .map((value): [unknown, unknown, string] => [rule({ minAmountMinor: value }), ctx(T2), MESSAGES.minAmountMinor]),
      ...[undefined, null, '', `usr_${'a'.repeat(31)}`, `usr_${'q'.repeat(32)}`, `USR_${'a'.repeat(32)}`, `${OWNER} `, 42, MARKER]
        .map((value): [unknown, unknown, string] => [fresh, { actorRef: value, now: T2 }, MESSAGES.actor]),
      [fresh, null, MESSAGES.actor],
      ...[undefined, null, '', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00.000+00:00', '2026-02-30T09:00:00.000Z',
        '2026-10-02 09:00:00.000Z', '2026-13-02T09:00:00.000Z', Date.parse(T2), new Date(T2), MARKER]
        .map((value): [unknown, unknown, string] => [fresh, { actorRef: OWNER, now: value }, MESSAGES.now]),
    ];
    for (const [input, context, message] of cases) {
      const error = caught(() => createCardSpendingRule(db, input as never, context as never));
      expectRefusal(error, message);
      expect(error.message).not.toContain('SYNTHETIC');
    }
    const ids: unknown[] = [undefined, null, '', 'csr_', `csr_${'a'.repeat(31)}`, `csr_${'a'.repeat(33)}`, `csr_${'q'.repeat(32)}`,
      `CSR_${'a'.repeat(32)}`, `${existing.id} `, 42, {}, MARKER];
    for (const id of ids) expectRefusal(caught(() => revokeCardSpendingRule(db, id, ctx(T2))), MESSAGES.id);
    for (const [context, message] of [[null, MESSAGES.actor], [{ actorRef: MARKER, now: T2 }, MESSAGES.actor],
      [{ actorRef: OWNER, now: MARKER }, MESSAGES.now]] as Array<[unknown, string]>) {
      expectRefusal(caught(() => revokeCardSpendingRule(db, existing.id, context as never)), message);
    }
    expect(changes()).toBe(writes);
    expect(listCardSpendingRules(db)).toEqual([existing]);
  });

  it('has the table refuse rows written around the store', () => {
    installCardSpendingRulesSchema(db);
    const valid: Record<string, unknown> = { id: `csr_${'a'.repeat(32)}`, reason: 'asset-purchase', category: 'Precious metals',
      merchant_class: 'costco-online', currency: 'USD', min_amount_minor: 100_000, created_at: T1, created_by: OWNER,
      revoked_at: null, revoked_by: null };
    const insert = db.prepare(`INSERT INTO card_spending_rules
      (id, reason, category, merchant_class, currency, min_amount_minor, created_at, created_by, revoked_at, revoked_by)
      VALUES (@id, @reason, @category, @merchant_class, @currency, @min_amount_minor, @created_at, @created_by, @revoked_at, @revoked_by)`);
    const outcome = (patch: Record<string, unknown>) => {
      try {
        insert.run({ ...valid, ...patch });
        return 'inserted';
      } catch (error) {
        return (error as { code?: unknown }).code;
      }
    };
    const refusedByChecks: Array<[string, Record<string, unknown>]> = [
      ['id prefix', { id: `csx_${'a'.repeat(32)}` }], ['id length', { id: `csr_${'a'.repeat(31)}` }],
      ['id letters', { id: `csr_${'a'.repeat(31)}q` }], ['id capitals', { id: `csr_${'A'.repeat(32)}` }],
      ['id blob', { id: Buffer.from(`csr_${'a'.repeat(32)}`) }],
      ['reason', { reason: 'income' }], ['category', { category: 'precious metals' }],
      ['merchant class', { merchant_class: 'costco' }],
      ['currency case', { currency: 'usd' }], ['currency length', { currency: 'USDX' }], ['currency letters', { currency: 'U$D' }],
      ['amount zero', { min_amount_minor: 0 }], ['amount negative', { min_amount_minor: -100 }],
      ['amount too large', { min_amount_minor: 1_000_000_000_000 }], ['amount fraction', { min_amount_minor: 1.5 }],
      ['created_at without milliseconds', { created_at: '2026-10-01T09:00:00Z' }],
      ['created_at no such day', { created_at: '2026-02-30T09:00:00.000Z' }],
      ['created_at separator', { created_at: '2026-10-01 09:00:00.000Z' }],
      ['created_by letters', { created_by: `usr_${'q'.repeat(32)}` }], ['created_by length', { created_by: `usr_${'a'.repeat(31)}` }],
      ['revoked_at alone', { revoked_at: T2 }], ['revoked_by alone', { revoked_by: OWNER }],
      ['revoked_at format', { revoked_at: 'yesterday', revoked_by: OWNER }],
      ['revoked_by shape', { revoked_at: T2, revoked_by: `usr_${'a'.repeat(31)}` }],
    ];
    for (const [name, patch] of refusedByChecks) expect(outcome(patch), name).toBe('SQLITE_CONSTRAINT_CHECK');
    for (const column of ['id', 'reason', 'category', 'merchant_class', 'currency', 'min_amount_minor', 'created_at', 'created_by']) {
      expect(outcome({ [column]: null }), column).toBe('SQLITE_CONSTRAINT_NOTNULL');
    }
    expect(listCardSpendingRules(db)).toEqual([]);

    const letters = 'bcdef';
    CARD_METALS_MERCHANT_CLASSES.forEach((merchantClass, index) => {
      expect(outcome({ id: `csr_${letters[index].repeat(32)}`, merchant_class: merchantClass }), merchantClass).toBe('inserted');
    });
    expect(outcome({ id: `csr_${'g'.repeat(32)}`, currency: 'EUR', min_amount_minor: 999_999_999_999, revoked_at: T2,
      revoked_by: OTHER_OWNER })).toBe('inserted');
    expect(outcome({ id: `csr_${'b'.repeat(32)}` })).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
    expect(listCardSpendingRules(db).map((item) => [item.merchantClass, item.revokedAt]))
      .toEqual([...CARD_METALS_MERCHANT_CLASSES.map((merchantClass) => [merchantClass, null]), ['costco-online', T2]]);
  });

  it('skips a row the checks should have refused, for reads and revokes alike', () => {
    installCardSpendingRulesSchema(db);
    const kept = createCardSpendingRule(db, rule(), ctx(T1));
    const forged = `csr_${'b'.repeat(32)}`;
    db.pragma('ignore_check_constraints = ON');
    db.prepare(`INSERT INTO card_spending_rules VALUES (?, 'income', 'Precious metals', 'costco-online', 'USD', 100000, ?, ?, NULL, NULL)`)
      .run(forged, T1, OWNER);
    db.pragma('ignore_check_constraints = OFF');
    expect(listCardSpendingRules(db)).toEqual([kept]);
    expect(revokeCardSpendingRule(db, forged, ctx(T2))).toBeNull();
    expect(stored(forged)).toEqual({ created_by: OWNER, revoked_at: null, revoked_by: null });
  });

  it('turns a database failure into a value-free error', () => {
    installCardSpendingRulesSchema(db);
    const created = createCardSpendingRule(db, rule(), ctx(T1));
    db.close();
    for (const operation of [
      () => cardSpendingRulesSchemaState(db),
      () => hasCardSpendingRulesSchema(db),
      () => installCardSpendingRulesSchema(db),
      () => listCardSpendingRules(db),
      () => createCardSpendingRule(db, rule({ currency: 'EUR' }), ctx(T2)),
      () => revokeCardSpendingRule(db, created.id, ctx(T2)),
    ]) {
      const error = caught(operation);
      expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
      expect(error.message).toMatch(/^(read owner spending rules schema|[a-z ]+ owner spending rules?) failed \(UNKNOWN\)$/);
    }
  });
});
