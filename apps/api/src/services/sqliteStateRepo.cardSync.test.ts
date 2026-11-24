import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  CARD_SYNC_CONTRACT_VERSION,
  CARD_SYNC_IDENTITY_NAMESPACES,
  CARD_SYNC_SOURCE_SPECS,
  containsCardData,
  containsCardSecret,
} from '@finance-tracker/shared';
import { CardSyncFixtures } from '../testing/cardSyncFixtures.js';
import { cardSchemaDump } from '../testing/cardSchemaDump.js';
import { downgradeCardSchema } from '../testing/cardSchemaDowngrade.js';
import {
  CARD_TEST_OWNER_REF,
  CARD_TEST_T0,
  cardFileRow,
  seedBrokerageForCardTests,
  seedCardLedger,
  withCardFunctions,
  writeV14CardLedger,
} from '../testing/cardSyncLedgerSeed.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CARD_SCHEMA, CARD_TABLES, type CardTable } from './cardGuards.js';
import { LEGACY_NAMESPACE, LEGACY_SCOPE_LABEL } from './cardLedger/migrateV15.js';
import { rowContentDigest } from './cardSyncDigests.js';
import { CARD_SYNC_BLOCKS } from './cardSyncSchemaSql.js';
import { HoldrDbError, HoldrRefusal } from './dbErrors.js';
import { CARD_GUARD_BUILD, SqliteStateRepo, type CardGuardBuild } from './sqliteStateRepo.js';

// Card-sync schema v15 (E1b design §3, §7.1 M, §7.5 G): the migration on
// real, file-backed databases. One schema however a database reached v15
// (the golden file of §3.6); every v14 row kept and the legacy ledger
// backfilled (§3.2); an upgrade that cannot finish leaves the v14 file byte
// for byte, whatever step fails; the preconditions and the stored-row
// re-check refuse without quoting a stored value; and the guards cover every
// column of the 28 new tables. Crashes and second processes are in
// cardSync.concurrency.test.ts.

type RawDb = Database.Database;

const GOLDEN = fileURLToPath(new URL('./__fixtures__/card-schema-v15.sql', import.meta.url));
const clock = () => new Date(CARD_TEST_T0);
const GUARD_REVISION = CARD_GUARD_BUILD.revision;

let dir: string;

beforeEach(async () => {
  dir = await makeScratchDir('card-sync-schema-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeScratchDir(dir);
});

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The main file's bytes and which sidecar files exist: what "byte for byte" compares. */
function fileState(file: string) {
  return { sha256: sha256(file), sidecars: ['-wal', '-shm', '-journal'].filter((suffix) => fs.existsSync(`${file}${suffix}`)) };
}

function withRaw<T>(file: string, read: (db: RawDb) => T): T {
  const db = new Database(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const open = (file: string, cardGuards?: CardGuardBuild) => new SqliteStateRepo({ file, now: clock, cardGuards });

/** Everything in the database: schema objects by type and name, and every row of every table in rowid order. */
function wholeDatabase(db: RawDb) {
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const rows = Object.fromEntries(schema.filter((o) => o.type === 'table')
    .map(({ name }) => [name, db.prepare(`SELECT rowid AS "(rowid)", * FROM "${name}" ORDER BY rowid`).all()]));
  return { version: db.pragma('user_version', { simple: true }), schema, rows };
}

const isCardName = (name: string) => name.startsWith('card_') || name.startsWith('trg_card_') || name.startsWith('idx_card_');

/** The database without its card objects and rows: what a card upgrade must leave alone. */
function nonCard(db: RawDb) {
  const whole = wholeDatabase(db);
  return {
    schema: whole.schema.filter((o) => !isCardName(o.tbl_name)),
    rows: Object.fromEntries(Object.entries(whole.rows).filter(([table]) => !isCardName(table))),
  };
}

/** A card-number-shaped canary made at run time (Luhn-valid, Visa-length), grouped as a statement prints it. */
function plantedCardNumber(): { digits: string; grouped: string } {
  const body = `4${Array.from({ length: 14 }, () => randomInt(10)).join('')}`;
  const sum = [...body].reverse().reduce((total, char, i) => {
    const d = Number(char) * (i % 2 === 0 ? 2 : 1);
    return total + (d > 9 ? d - 9 : d);
  }, 0);
  const digits = `${body}${(10 - (sum % 10)) % 10}`;
  return { digits, grouped: digits.replace(/(\d{4})(?=\d)/g, '$1 ') };
}

/** A message carries no stored value: none of the planted ones, and nothing either detector flags. */
function expectValueFree(message: string, planted: readonly string[]): void {
  for (const value of planted) expect(message, `message holds ${JSON.stringify(value)}`).not.toContain(value);
  expect(containsCardData(message), message).toBe(false);
  expect(containsCardSecret(message), message).toBe(false);
}

const storedRowsRefusal = (listed: string[]) =>
  `stored card rows fail this build's card guards (revision ${GUARD_REVISION}): ${listed.join(', ')}. Refusing to open the ` +
  'database; nothing was changed. Restore a backup made before those rows were written, or fix or delete them with the build ' +
  'that wrote them, then open the database with this build again.';

const preconditionRefusal = (precondition: string, problem: string) =>
  `card schema v15 upgrade refused (${precondition}): ${problem}. Nothing was changed; restore a backup made before those rows ` +
  'were written, or fix them with the build that wrote them, then open the database again.';

/**
 * Opening `file` (after `arm`, which may install a failure) fails; the main
 * file and its sidecars are as they were, and the database is still the v14
 * it was, rows and schema.
 */
function expectUpgradeRefused(file: string, arm: () => void = () => {}): Error {
  const before = withRaw(file, wholeDatabase);
  const state = fileState(file);
  let error: unknown;
  arm();
  try {
    open(file).close();
  } catch (caught) {
    error = caught;
  } finally {
    vi.restoreAllMocks();
  }
  expect(error, 'the upgrade was refused').toBeInstanceOf(Error);
  expect(fileState(file)).toEqual(state);
  withRaw(file, (db) => {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(wholeDatabase(db)).toEqual(before);
  });
  expect(before.version).toBe(14);
  return error as Error;
}

describe('card schema v15: one schema however the database reached it (M1, M2, M5)', () => {
  it('creates it fresh: v15, 31 guarded card tables, the design\'s 113 triggers, and exactly the golden dump', async () => {
    const repo = open(path.join(dir, 'fresh.db'));
    try {
      const db = repo.internalGetDb();
      expect(repo.schemaVersion()).toBe(15);
      const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name LIKE 'card\\_%' ESCAPE '\\'")
        .all() as Array<{ type: string; name: string }>;
      expect(objects.filter((o) => o.type === 'table').map((o) => o.name).sort()).toEqual([...CARD_TABLES].sort());
      const triggers = objects.filter((o) => o.type === 'trigger').map((o) => o.name);
      const guard = (name: string) => /^trg_card\w*_guard_(insert|update)$/.test(name);
      expect(triggers.filter(guard)).toHaveLength(2 * CARD_TABLES.length);
      const designed = [...Object.values(CARD_SYNC_BLOCKS).join('\n').matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]);
      expect(designed).toHaveLength(113);
      expect(triggers.filter((name) => !guard(name)).sort()).toEqual(designed.sort());
      await expect(cardSchemaDump(db)).toMatchFileSnapshot(GOLDEN);
    } finally {
      repo.close();
    }
  });

  const builders: Array<[string, (file: string) => void]> = [
    ['v12 (before card spending)', (file) => {
      const repo = open(file);
      seedBrokerageForCardTests(repo);
      repo.close();
      withRaw(file, (db) => {
        db.pragma('foreign_keys = OFF');
        for (const table of [...CARD_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
        db.pragma('user_version = 12');
      });
    }],
    ['v13 (Phase 3) with data', (file) => {
      const repo = open(file);
      seedBrokerageForCardTests(repo);
      seedCardLedger(repo);
      repo.close();
      downgradeCardSchema(file, 13);
    }],
    ['v14 (Phase 4) with data', (file) => { writeV14CardLedger(file); }],
  ];

  it.each(builders)('upgrades a %s database to exactly the golden dump, its other tables untouched', (label, build) => {
    const file = path.join(dir, 'older.db');
    build(file);
    const before = withRaw(file, nonCard);
    expect(withRaw(file, (db) => db.pragma('user_version', { simple: true })), label).toBeLessThan(15);
    open(file).close();
    withRaw(file, (db) => {
      expect(cardSchemaDump(db)).toBe(fs.readFileSync(GOLDEN, 'utf8'));
      expect(nonCard(db)).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });
});

describe('card schema v15: the upgrade keeps every v14 row and backfills the legacy ledger (M3, M4, M15–M17)', () => {
  const V14_COLUMNS: Record<'card_accounts' | 'card_import_batches' | 'card_transactions', readonly string[]> = {
    card_accounts: ['id', 'issuer', 'owner', 'nickname', 'last4', 'currency', 'status', 'created_at', 'updated_at', 'last5'],
    card_import_batches: ['id', 'card_account_id', 'source', 'parser_version', 'row_count', 'new_count', 'duplicate_count',
      'rejected_count', 'imported_at', 'coverage_start', 'coverage_end'],
    card_transactions: ['id', 'card_account_id', 'source', 'external_id_hash', 'fingerprint', 'transaction_date', 'posted_date',
      'status', 'amount_minor', 'currency', 'original_amount_minor', 'original_currency', 'kind', 'description', 'merchant',
      'issuer_category', 'user_category', 'notes', 'import_batch_id', 'created_at', 'updated_at', 'dismissed_at'],
  };
  const v14Rows = (db: RawDb) => Object.fromEntries(Object.entries(V14_COLUMNS).map(([table, columns]) => [table,
    db.prepare(`SELECT rowid AS "(rowid)", ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all()]));

  it('keeps every v14 column of every row, with its rowid, and every read the same', () => {
    const file = path.join(dir, 'm4.db');
    const repo = open(file);
    seedBrokerageForCardTests(repo);
    seedCardLedger(repo);
    const reads = (r: SqliteStateRepo) => ({
      accounts: r.listCardAccounts(),
      batches: r.listCardImportBatches(),
      transactions: r.listCardTransactions(),
      page: r.queryCardTransactions({ statuses: ['pending', 'posted', 'removed'] }, { limit: 200 }),
      coverage: r.listCardCoverage(),
    });
    const before = reads(repo);
    repo.close();
    downgradeCardSchema(file, 14);
    const stored = withRaw(file, v14Rows);
    expect(stored.card_transactions).toHaveLength(9);

    const upgraded = open(file);
    try {
      expect(reads(upgraded)).toEqual(before);
      expect(v14Rows(upgraded.internalGetDb())).toEqual(stored);
    } finally {
      upgraded.close();
    }
  });

  it('backfills one legacy scope, identity, baseline and coverage window per v14 fact, and audits the upgrade once', () => {
    const file = path.join(dir, 'm3.db');
    const seeded = writeV14CardLedger(file);
    const stored = withRaw(file, v14Rows);
    const repo = open(file);
    try {
      const db = repo.internalGetDb();
      const all = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
      const accounts = stored.card_accounts as Array<{ id: string }>;
      const scopes = all<Record<string, unknown>>("SELECT * FROM card_scopes ORDER BY rowid");
      expect(scopes).toHaveLength(accounts.length);
      const legacy = new Map(scopes.map((s) => [s.card_account_id as string, s.id as string]));
      for (const scope of scopes) {
        expect(scope).toMatchObject({
          kind: 'legacy', holder_alias: 'unknown', last4: null, label: LEGACY_SCOPE_LABEL, status: 'active', version: 1,
          confirmed_by_ref: null, confirmed_at: null, retired_at: null, created_at: CARD_TEST_T0, updated_at: CARD_TEST_T0,
        });
        expect(scope.id).toMatch(/^scp_[a-p]{32}$/);
      }
      expect([...legacy.keys()].sort()).toEqual(accounts.map((a) => a.id).sort());

      type V14Txn = Record<string, string | number | null> & { id: string; status: string; posted_date: string | null };
      const rows = stored.card_transactions as V14Txn[];
      const removal = (t: V14Txn) => {
        if (t.status !== 'removed') return { removed_reason: null, removed_from_status: null, removed_at: null };
        if (t.dismissed_at !== null) return { removed_reason: 'dismissed', removed_from_status: 'pending', removed_at: t.dismissed_at };
        return { removed_reason: 'legacy', removed_from_status: null, removed_at: t.updated_at };
      };
      const firstSeen = (t: V14Txn) => (t.status !== 'removed' ? t.status : t.dismissed_at !== null ? 'pending'
        : t.posted_date ? 'posted' : 'pending');
      const v15 = new Map(all<Record<string, unknown>>('SELECT * FROM card_transactions').map((t) => [t.id, t]));
      const identities = new Map(all<Record<string, unknown>>('SELECT * FROM card_source_identities')
        .map((i) => [i.canonical_transaction_id, i]));
      const contents = new Map(all<Record<string, unknown>>('SELECT * FROM card_identity_contents').map((c) => [c.identity_id, c]));
      expect(identities.size).toBe(rows.length);
      expect(contents.size).toBe(rows.length);
      expect(rows.filter((t) => t.status === 'removed').map((t) => removal(t).removed_reason).sort())
        .toEqual(['dismissed', 'legacy', 'legacy']);
      for (const t of rows) {
        expect(v15.get(t.id), t.id).toMatchObject({
          card_scope_id: legacy.get(t.card_account_id as string), revision: 1, first_sync_run_id: null, merged_into_id: null,
          reversal_snapshot_revision: null, ...removal(t),
        });
        const identity = identities.get(t.id)!;
        expect(identity, t.id).toMatchObject({
          card_account_id: t.card_account_id, source_scope_id: legacy.get(t.card_account_id as string),
          source_scope_kind: 'legacy', namespace: LEGACY_NAMESPACE, namespace_kind: 'legacy-file',
          id_hash: t.external_id_hash ?? t.fingerprint, status: 'active', first_seen_status: firstSeen(t),
          created_origin: 'migration', import_batch_id: t.import_batch_id, first_observation_id: null, created_at: CARD_TEST_T0,
          last_seen_at: null, last_seen_run_id: null,
        });
        expect(identity.id).toMatch(/^card-ident-[a-p]{32}$/);
        expect(contents.get(identity.id), t.id).toEqual({
          identity_id: identity.id, resolution: 'migration-baseline', recorded_at: CARD_TEST_T0,
          content_digest: rowContentDigest({
            transactionDate: t.transaction_date as string, postedDate: t.posted_date, status: firstSeen(t) as 'pending' | 'posted',
            amountMinor: t.amount_minor as number, kind: t.kind as string, description: t.description as string,
            merchant: t.merchant as string | null, issuerCategory: t.issuer_category as string | null,
            originalAmountMinor: t.original_amount_minor as number | null, originalCurrency: t.original_currency as string | null,
          }),
        });
      }
      const covered = (stored.card_import_batches as Array<Record<string, string | null>>).filter((b) => b.coverage_start !== null);
      expect(covered).toHaveLength(1);
      expect(all('SELECT * FROM card_coverage_windows')).toEqual(covered.map((b) => expect.objectContaining({
        card_account_id: b.card_account_id, card_scope_id: legacy.get(b.card_account_id!), source_kind: 'file', source: b.source,
        import_batch_id: b.id, observation_set_id: null, entry_ordinal: null, status: 'any', requested_start: b.coverage_start,
        requested_end: b.coverage_end, requested_basis: 'posted-or-transaction', observed_start: null, observed_end: null,
        observed_basis: null, claimed_completeness: 'unknown', verified_completeness: 'unknown', termination: null,
        page_count: null, evidence: 'file-declared', ledger_state: 'committed', observed_at: null, recorded_at: CARD_TEST_T0,
        updated_at: CARD_TEST_T0,
      })));
      expect(all('SELECT event_type, actor_kind, actor_ref, row_count, created_at FROM card_sync_audit_events')).toEqual([{
        event_type: 'migration-completed', actor_kind: 'migration', actor_ref: null, row_count: rows.length, created_at: CARD_TEST_T0,
      }]);
      expect(all('SELECT revision, paused, paused_at, recovery_completed_at, updated_by_ref, generation_changed_at FROM card_sync_policy'))
        .toEqual([{ revision: 1, paused: 0, paused_at: null, recovery_completed_at: null, updated_by_ref: null, generation_changed_at: CARD_TEST_T0 }]);
      expect(all('SELECT id, enabled, approved_contract_version, main_passive_accepted, revision FROM card_sync_issuer_policy ORDER BY id'))
        .toEqual(['amex', 'chase', 'citi', 'wellsfargo'].map((id) => ({
          id, enabled: 0, approved_contract_version: null, main_passive_accepted: 0, revision: 1,
        })));
      for (const table of ['card_transaction_events', 'card_transaction_versions', 'card_sync_observation_sets',
        'card_reconciliation_suggestions', 'card_sync_commit_plans', 'card_sync_devices', 'card_sync_pairings']) {
        expect(all(`SELECT 1 FROM ${table}`), `${table}: the v14 state is the baseline`).toEqual([]);
      }
      expect(all('SELECT ledger_revision FROM card_accounts')).toEqual(accounts.map(() => ({ ledger_revision: 0 })));
      expect(all('PRAGMA foreign_key_check')).toEqual([]);
      expect(seeded.legacyRemovedIds.every((id) => v15.get(id)?.removed_reason === 'legacy')).toBe(true);
    } finally {
      repo.close();
    }
  });

  it('replays every v14 import as duplicates afterwards, writing no row, identity, content, event or review item (M17)', () => {
    const file = path.join(dir, 'm17.db');
    const { imports } = writeV14CardLedger(file);
    const repo = open(file);
    try {
      const db = repo.internalGetDb();
      const ledger = () => Object.fromEntries(['card_transactions', 'card_source_identities', 'card_identity_contents',
        'card_transaction_events', 'card_transaction_versions', 'card_reconciliation_suggestions', 'card_sync_observation_sets']
        .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const before = ledger();
      const revisions = db.prepare('SELECT id, ledger_revision FROM card_accounts ORDER BY id').all();
      for (const input of imports) {
        const batch = repo.importCardTransactions(input);
        expect(batch).toMatchObject({ newCount: 0, duplicateCount: input.rows.length });
      }
      expect(ledger()).toEqual(before);
      expect(db.prepare('SELECT id, ledger_revision FROM card_accounts ORDER BY id').all()).toEqual(revisions);
    } finally {
      repo.close();
    }
  });

  it('creates exactly one legacy scope with each new card account, in the same transaction (M15)', () => {
    const repo = open(path.join(dir, 'm15.db'));
    try {
      const db = repo.internalGetDb();
      const first = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' });
      expect(db.prepare('SELECT card_account_id, kind, label FROM card_scopes').all())
        .toEqual([{ card_account_id: first.id, kind: 'legacy', label: LEGACY_SCOPE_LABEL }]);
      const prepare = Database.prototype.prepare;
      vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: RawDb, source: string) {
        if (source.includes('INSERT INTO card_scopes')) throw new Error('injected failure');
        return prepare.call(this, source);
      } as RawDb['prepare']);
      expect(() => repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' }))
        .toThrow(HoldrDbError);
      vi.restoreAllMocks();
      expect(repo.listCardAccounts().map((a) => a.id)).toEqual([first.id]);
      expect(db.prepare('SELECT count(*) AS n FROM card_scopes').get()).toEqual({ n: 1 });
    } finally {
      repo.close();
    }
  });

  it('seeds the source and namespace registries from E1a\'s contract, plus the legacy file namespace (M16)', () => {
    const repo = open(path.join(dir, 'm16.db'));
    try {
      const db = repo.internalGetDb();
      expect(db.prepare('SELECT source, issuer, mode, contract_version FROM card_sync_sources ORDER BY source').all()).toEqual(
        Object.entries(CARD_SYNC_SOURCE_SPECS).map(([source, spec]) => ({
          source, issuer: spec.issuer, mode: spec.mode, contract_version: CARD_SYNC_CONTRACT_VERSION,
        })).sort((a, b) => a.source.localeCompare(b.source)),
      );
      const expected = [
        { namespace: LEGACY_NAMESPACE, kind: 'legacy-file', source: null, contract_version: null },
        ...Object.entries(CARD_SYNC_SOURCE_SPECS).flatMap(([source, spec]) => [
          ...spec.stableNamespaces.map((namespace) => ({ namespace, kind: 'stable', source, contract_version: CARD_SYNC_CONTRACT_VERSION })),
          { namespace: spec.captureNamespace, kind: 'capture', source, contract_version: CARD_SYNC_CONTRACT_VERSION },
        ]),
      ].sort((a, b) => a.namespace.localeCompare(b.namespace));
      expect(db.prepare('SELECT namespace, kind, source, contract_version FROM card_sync_namespaces ORDER BY namespace').all())
        .toEqual(expected);
      expect(expected.map((row) => row.namespace).filter((ns) => ns !== LEGACY_NAMESPACE).sort())
        .toEqual([...CARD_SYNC_IDENTITY_NAMESPACES].sort());
    } finally {
      repo.close();
    }
  });

  it('reopens an up-to-date database without writing a byte or calling a detector (M6)', () => {
    const file = path.join(dir, 'm6.db');
    const repo = open(file);
    seedCardLedger(repo);
    repo.close();
    const before = fileState(file);
    const calls = { data: 0, secret: 0 };
    const counted: CardGuardBuild = {
      ...CARD_GUARD_BUILD,
      detectors: {
        containsCardData: (text) => { calls.data += 1; return containsCardData(text); },
        containsCardSecret: (text) => { calls.secret += 1; return containsCardSecret(text); },
      },
    };
    const reopened = open(file, counted);
    try {
      expect(fs.statSync(`${file}-wal`).size, 'nothing was written to the WAL').toBe(0);
    } finally {
      reopened.close();
    }
    expect(calls).toEqual({ data: 0, secret: 0 });
    expect(fileState(file)).toEqual(before);
  });
});

describe('card schema v15: an upgrade that cannot finish changes nothing', () => {
  let fixtureDir: string;
  let v14File: string;

  beforeAll(async () => {
    fixtureDir = await makeScratchDir('card-sync-v14-');
    v14File = path.join(fixtureDir, 'v14.db');
    writeV14CardLedger(v14File);
  });

  afterAll(async () => {
    await removeScratchDir(fixtureDir);
  });

  const copyOfV14 = (name: string) => {
    const file = path.join(dir, name);
    fs.copyFileSync(v14File, file);
    return file;
  };

  // Every step of design §3.1 (and the version stamp after it), by the statement that starts it.
  type Hook = { method: 'exec' | 'prepare' | 'pragma'; matches: (source: string) => boolean };
  const block = (name: string): Hook => ({ method: 'exec', matches: (source) => source.startsWith(`-- @block ${name}\n`) });
  const prepared = (fragment: string): Hook => ({ method: 'prepare', matches: (source) => source.includes(fragment) });
  const STEPS: Array<[string, Hook]> = [
    ['at the preconditions (step 0)', prepared('PRAGMA foreign_key_check(card_transactions)')],
    ...['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '3.4a', '2.10'].map((name): [string, Hook] => [`at block ${name}`, block(name)]),
    ['in the copy of card_transactions (3.4b)', prepared('FROM card_transactions_v14 t')],
    ...['3.4c', '2.8', '2.9', '2.11', '2.12', '2.13', '2.14', '2.15', '2.16', '2.17', '2.18']
      .map((name): [string, Hook] => [`at block ${name}`, block(name)]),
    ['in the legacy backfill (step 11)', prepared('INSERT INTO card_source_identities')],
    ['at block 2.19 (the invariant triggers)', block('2.19')],
    ['in the post-checks (step 13)', prepared('PRAGMA foreign_key_check(card_sync_sources)')],
    ['at the audit row (step 14)', prepared("'migration-completed'")],
    ['in the stored-row re-check', prepared('SELECT "id", CASE WHEN')],
    ['in the guard install', { method: 'exec', matches: (source) => source.startsWith('CREATE TRIGGER trg_card_sync_audit_events_guard_') }],
    ['at the version stamp', { method: 'pragma', matches: (source) => source === 'user_version = 15' }],
  ];

  it('covers every block the migration runs', () => {
    const blocks = STEPS.map(([label]) => /^at block ([0-9.a-z]+)/.exec(label)?.[1]).filter(Boolean).sort();
    expect(blocks).toEqual(Object.keys(CARD_SYNC_BLOCKS).filter((name) => name !== '3.4b').sort());
  });

  it.each(STEPS)('a failure %s rolls the whole upgrade back, leaving the v14 file byte for byte', (label, hook) => {
    const file = copyOfV14('failing.db');
    const original = Database.prototype[hook.method] as (this: RawDb, ...args: unknown[]) => unknown;
    let hit = false;
    const error = expectUpgradeRefused(file, () => {
      vi.spyOn(Database.prototype, hook.method).mockImplementation(function (this: RawDb, ...args: unknown[]) {
        if (!hit && typeof args[0] === 'string' && hook.matches(args[0])) {
          hit = true;
          throw new Error(`injected failure ${label}`);
        }
        return original.apply(this, args);
      } as never);
    });
    expect(hit, `the upgrade reached the hook ${label}`).toBe(true);
    expect(Object.getPrototypeOf(error)).toBe(HoldrDbError.prototype);
    expect(error.message).toBe('open database failed (UNKNOWN)');

    open(file).close();
    expect(withRaw(file, cardSchemaDump)).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });

  const plant = (file: string, write: (db: RawDb) => void) => withRaw(file, (db) => {
    withCardFunctions(db);
    write(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
  });

  it.each<[string, string, (db: RawDb) => void]>([
    ['P1', '1 schema object(s) besides card_transactions refer to it',
      (db) => db.exec('CREATE VIEW card_spend_view AS SELECT id, amount_minor FROM card_transactions')],
    ['P2', '1 card transaction(s) are in a currency other than their card account\'s',
      (db) => db.exec("UPDATE card_transactions SET currency = 'EUR' WHERE rowid = (SELECT min(rowid) FROM card_transactions)")],
    ['P3', '1 dedupe key(s) are stored more than once for one card account', (db) => {
      db.exec('DROP INDEX idx_card_transactions_external_id');
      db.exec(`UPDATE card_transactions SET external_id_hash = (SELECT external_id_hash FROM card_transactions
          WHERE external_id_hash IS NOT NULL ORDER BY rowid LIMIT 1)
        WHERE rowid = (SELECT rowid FROM card_transactions WHERE external_id_hash IS NOT NULL ORDER BY rowid LIMIT 1 OFFSET 1)`);
    }],
    ['P4', '1 card transaction reference(s) point at a missing card account or import batch', (db) => {
      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE card_transactions SET import_batch_id = ? WHERE rowid = (SELECT min(rowid) FROM card_transactions)')
        .run(`card-import-${'k'.repeat(32)}`);
    }],
    ['P5', '1 stored import source or parser version value(s) are outside the v1 grammar',
      (db) => db.exec("UPDATE card_import_batches SET parser_version = 'csv 1.0' WHERE rowid = (SELECT min(rowid) FROM card_import_batches)")],
  ])('refuses an upgrade whose v14 data breaks %s, by count and without a stored value (M10)', (precondition, problem, write) => {
    const file = copyOfV14(`${precondition}.db`);
    plant(file, write);
    const error = expectUpgradeRefused(file);
    expect(Object.getPrototypeOf(error)).toBe(HoldrRefusal.prototype);
    expect(error.message).toBe(preconditionRefusal(precondition, problem));
  });

  // Every v14 text column that can hold the planted text under v14's own CHECKs (the others refuse it as v14 wrote them).
  const PLANTED_COLUMNS: Array<[table: string, column: string, refusedBy: 'stored-row re-check' | 'P5']> = [
    ['card_accounts', 'issuer', 'stored-row re-check'],
    ['card_accounts', 'nickname', 'stored-row re-check'],
    ['card_accounts', 'created_at', 'stored-row re-check'],
    ['card_accounts', 'updated_at', 'stored-row re-check'],
    ['card_import_batches', 'source', 'P5'],
    ['card_import_batches', 'parser_version', 'P5'],
    ['card_import_batches', 'imported_at', 'stored-row re-check'],
    ['card_transactions', 'source', 'P5'],
    ['card_transactions', 'description', 'stored-row re-check'],
    ['card_transactions', 'merchant', 'stored-row re-check'],
    ['card_transactions', 'issuer_category', 'stored-row re-check'],
    ['card_transactions', 'user_category', 'stored-row re-check'],
    ['card_transactions', 'notes', 'stored-row re-check'],
    ['card_transactions', 'created_at', 'stored-row re-check'],
    ['card_transactions', 'updated_at', 'stored-row re-check'],
    ['card_transactions', 'dismissed_at', 'stored-row re-check'],
  ];

  it('plants into every v14 text column that can hold card data (and no other)', () => {
    const file = copyOfV14('columns.db');
    const card = plantedCardNumber();
    const holds: string[] = [];
    withRaw(file, (db) => {
      for (const table of ['card_accounts', 'card_import_batches', 'card_transactions']) {
        db.exec(`DROP TRIGGER trg_${table}_guard_insert; DROP TRIGGER trg_${table}_guard_update`);
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>)
          .filter((c) => c.type === 'TEXT' && c.pk === 0 && !['card_account_id', 'import_batch_id'].includes(c.name));
        for (const { name } of columns) {
          const savepoint = db.transaction(() => {
            db.prepare(`UPDATE ${table} SET "${name}" = ? WHERE rowid = (SELECT rowid FROM ${table} ${table === 'card_transactions'
              ? "WHERE status = 'removed' AND dismissed_at IS NOT NULL" : ''} ORDER BY rowid LIMIT 1)`).run(`paid ${card.grouped}`);
            holds.push(`${table}.${name}`);
            throw new Error('roll back');
          });
          try {
            savepoint();
          } catch {
            // refused by a CHECK, or rolled back after the UPDATE succeeded
          }
        }
      }
    });
    expect(holds.sort()).toEqual(PLANTED_COLUMNS.map(([table, column]) => `${table}.${column}`).sort());
  });

  it.each(PLANTED_COLUMNS)('refuses an upgrade over card data planted into %s.%s, without quoting it (M11)', (table, column, refusedBy) => {
    const file = copyOfV14(`${table}-${column}.db`);
    const card = plantedCardNumber();
    const planted = `paid ${card.grouped}`;
    let rowId = '';
    plant(file, (db) => {
      for (const t of ['card_accounts', 'card_import_batches', 'card_transactions']) {
        db.exec(`DROP TRIGGER trg_${t}_guard_insert; DROP TRIGGER trg_${t}_guard_update`);
      }
      rowId = (db.prepare(`SELECT id FROM ${table} ${table === 'card_transactions'
        ? "WHERE status = 'removed' AND dismissed_at IS NOT NULL" : ''} ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
      db.prepare(`UPDATE ${table} SET "${column}" = ? WHERE id = ?`).run(planted, rowId);
    });
    const error = expectUpgradeRefused(file);
    expect(Object.getPrototypeOf(error)).toBe(HoldrRefusal.prototype);
    expect(error.message).toBe(refusedBy === 'P5'
      ? preconditionRefusal('P5', '1 stored import source or parser version value(s) are outside the v1 grammar')
      : storedRowsRefusal([`${table}.${column} in row ${rowId}`]));
    expectValueFree(error.message, [planted, card.digits, card.grouped]);
  });

  // Review r1, finding 1: the guards main's v14 build left on the three v13/v14 tables, byte for byte, dropped by an outside
  // tool for one write and put back exactly as they were. A table v15 does not change (card_import_batches) keeps those very
  // guards, so only the upgrade's re-check of every card table, not just of those whose guards change, can find such a row.
  const V14_TABLES = ['card_accounts', 'card_import_batches', 'card_transactions'] as const;
  const CARD_SECRET_JSON = '{"cvv":"123","expiry":"12/29"}';
  // The v14 columns that can hold either planted text under v14's own CHECKs (the other 21 refuse it as v14 wrote them).
  const PLANTABLE_UNDER_V14_GUARDS = [
    'card_accounts.id', 'card_accounts.issuer', 'card_accounts.nickname', 'card_accounts.created_at', 'card_accounts.updated_at',
    'card_import_batches.id', 'card_import_batches.card_account_id', 'card_import_batches.source', 'card_import_batches.parser_version',
    'card_import_batches.imported_at',
    'card_transactions.id', 'card_transactions.card_account_id', 'card_transactions.source', 'card_transactions.description',
    'card_transactions.merchant', 'card_transactions.issuer_category', 'card_transactions.user_category', 'card_transactions.notes',
    'card_transactions.import_batch_id', 'card_transactions.created_at', 'card_transactions.updated_at', 'card_transactions.dismissed_at',
  ];
  const guardTriggers = (db: RawDb) => db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    AND name LIKE 'trg_card%_guard_%' ORDER BY name`).all() as Array<{ name: string; sql: string }>;

  it('refuses card data planted under the exact v14 guards in every v14 column, value-free and byte for byte (M11, r1 finding 1)', () => {
    const card = plantedCardNumber();
    const values = [['number', `paid ${card.grouped}`], ['secret', CARD_SECRET_JSON]] as const;
    const columns = withRaw(v14File, (db) => {
      // The file carries main's v14 guards byte for byte (pinned in sqliteStateRepo.test.ts): six, on the three tables only.
      expect(guardTriggers(db).map((t) => t.name)).toEqual(V14_TABLES.flatMap((t) => [`trg_${t}_guard_insert`, `trg_${t}_guard_update`]));
      return V14_TABLES.flatMap((table) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => [table, name] as const));
    });
    expect(columns).toHaveLength(43);
    const planted: Record<string, string[]> = { number: [], secret: [] };
    for (const [table, column] of columns) {
      for (const [kind, value] of values) {
        const file = copyOfV14(`exact-${table}-${column}-${kind}.db`);
        let rowId = '';
        let held = false;
        withRaw(file, (db) => {
          withCardFunctions(db);
          db.pragma('foreign_keys = OFF');
          const guards = guardTriggers(db);
          db.transaction(() => {
            for (const { name } of guards) db.exec(`DROP TRIGGER ${name}`);
            rowId = (db.prepare(`SELECT id FROM ${table} ${table === 'card_transactions'
              ? "WHERE status = 'removed' AND dismissed_at IS NOT NULL" : ''} ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
            try {
              db.prepare(`UPDATE ${table} SET "${column}" = ? WHERE id = ?`).run(value, rowId);
              held = true;
            } catch {
              // v14's own CHECK refuses the text, as v14 wrote the table
            }
            for (const { sql } of guards) db.exec(sql);
          })();
          expect(guardTriggers(db), 'the exact v14 guards are back').toEqual(guards);
          db.pragma('wal_checkpoint(TRUNCATE)');
        });
        if (!held) continue;
        planted[kind].push(`${table}.${column}`);
        const error = expectUpgradeRefused(file);
        expectValueFree(error.message, [value, card.digits, card.grouped]);
        if (table === 'card_import_batches' && column === 'imported_at') {
          // Nothing else in the upgrade reads it: the stored-row re-check is what refuses it.
          expect(Object.getPrototypeOf(error)).toBe(HoldrRefusal.prototype);
          expect(error.message).toBe(storedRowsRefusal([`card_import_batches.imported_at in row ${rowId}`]));
        }
      }
    }
    expect(planted).toEqual({ number: PLANTABLE_UNDER_V14_GUARDS, secret: PLANTABLE_UNDER_V14_GUARDS });
  });

  it('re-checks every stored v14 value on the upgrade, unchanged card_import_batches included (r1 finding 1)', () => {
    const file = copyOfV14('recheck-all.db');
    const expected = withRaw(file, (db) => V14_TABLES.flatMap((table) => {
      const text = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
        .filter((c) => c.type === 'TEXT').map((c) => `"${c.name}"`);
      return (db.prepare(`SELECT ${text.join(', ')} FROM ${table}`).raw().all() as unknown[][]).flat()
        .filter((value): value is string => typeof value === 'string');
    }));
    const batchTimes = withRaw(file, (db) => db.prepare('SELECT imported_at FROM card_import_batches').pluck().all() as string[]);
    expect(batchTimes.length).toBeGreaterThan(0);
    const checked = new Set<string>();
    const counted: CardGuardBuild = {
      ...CARD_GUARD_BUILD,
      detectors: {
        containsCardData: (text) => { checked.add(text); return containsCardData(text); },
        containsCardSecret: (text) => { checked.add(text); return containsCardSecret(text); },
      },
    };
    open(file, counted).close();
    for (const value of expected) expect(checked.has(value), 'every stored v14 text value is re-checked').toBe(true);
    for (const value of batchTimes) expect(checked.has(value), 'card_import_batches.imported_at is re-checked').toBe(true);
    // An ordinary reopen of the upgraded database checks no stored row (M6).
    checked.clear();
    open(file, counted).close();
    expect(checked.size).toBe(0);
  });
});

describe('card schema v15: guards on every column of the 28 new tables (G1, G2)', () => {
  const NEW_TABLES = CARD_TABLES.slice(3) as readonly CardTable[];

  it('lists every column of all 31 card tables in CARD_SCHEMA exactly as SQLite has it (G2)', () => {
    const repo = open(path.join(dir, 'g2.db'));
    try {
      const db = repo.internalGetDb();
      for (const table of CARD_TABLES) {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
          .map((c) => [c.name, c.type]);
        expect(columns, table).toEqual([...CARD_SCHEMA[table].columns]);
      }
      expect(NEW_TABLES).toHaveLength(28);
    } finally {
      repo.close();
    }
  });

  const card = plantedCardNumber();
  const ARABIC_INDIC = [...card.digits].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
  const POISONS = [
    { label: 'ASCII digit run', text: `SYNTHETIC ${card.digits} TEST`, integer: Number(card.digits),
      TEXT: 'must not contain 13 or more consecutive digits', INTEGER: 'must not contain 13 or more consecutive digits' },
    { label: 'BLOB', text: Buffer.from(card.digits), integer: Buffer.from(card.digits),
      TEXT: 'must be stored as text', INTEGER: 'must be stored as an integer' },
    { label: 'NUL-embedded text', text: `safe\0${card.digits}`, integer: `0\0${card.digits}`,
      TEXT: 'must not contain NUL characters', INTEGER: 'must be stored as an integer' },
    { label: 'Arabic-Indic digits', text: ARABIC_INDIC, integer: ARABIC_INDIC,
      TEXT: 'must not contain non-ASCII digits or invisible characters', INTEGER: 'must be stored as an integer' },
    { label: 'grouped digits', text: card.grouped, integer: card.grouped,
      TEXT: 'must not contain a card number', INTEGER: 'must be stored as an integer' },
    { label: 'labeled security code', text: 'CVV 123', integer: 'CVV 123',
      TEXT: 'must not contain a card security code, PIN or expiry date', INTEGER: 'must be stored as an integer' },
  ];
  const cases = (table: CardTable) => [...CARD_SCHEMA[table].columns].flatMap(([column, type]) => POISONS.map((poison) => ({
    column, label: poison.label, value: type === 'INTEGER' ? poison.integer : poison.text,
    message: `${table}.${column} ${type === 'INTEGER' ? poison.INTEGER : poison.TEXT}`,
  })));
  const raised = (write: () => unknown) => {
    try {
      write();
      return 'accepted';
    } catch (error) {
      return (error as Error).message;
    }
  };

  it.each(NEW_TABLES)('refuses every card data representation in every %s column on INSERT', (table) => {
    const repo = open(path.join(dir, 'g1-insert.db'));
    try {
      const db = repo.internalGetDb();
      for (const { column, label, value, message } of cases(table)) {
        expect(raised(() => db.prepare(`INSERT INTO ${table} ("${column}") VALUES (?)`).run(value)), `${column}: ${label}`).toBe(message);
      }
    } finally {
      repo.close();
    }
  });

  it('guards UPDATE exactly as INSERT on every card table', () => {
    const repo = open(path.join(dir, 'g1-text.db'));
    try {
      const db = repo.internalGetDb();
      for (const table of CARD_TABLES) {
        const sql = (event: 'insert' | 'update') => (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
          .get(`trg_${table}_guard_${event}`) as { sql: string }).sql;
        expect(sql('update'), table).toBe(sql('insert')
          .replace(`trg_${table}_guard_insert\nBEFORE INSERT ON`, `trg_${table}_guard_update\nBEFORE UPDATE ON`));
      }
    } finally {
      repo.close();
    }
  });

  it('refuses every card data representation on UPDATE of every new table that holds a row', () => {
    const repo = open(path.join(dir, 'g1-update.db'));
    try {
      const db = repo.internalGetDb();
      const account = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' }).id;
      repo.importCardTransactions({
        cardAccountId: account, source: 'chase-csv', parserVersion: 'csv@1.0.0', coverage: { start: '2026-09-01', end: '2026-09-30' },
        rows: [cardFileRow({ status: 'pending', postedDate: null })],
      });
      repo.importCardTransactions({ cardAccountId: account, source: 'chase-csv', parserVersion: 'csv@1.0.0', rows: [cardFileRow()],
        promoteFingerprintMatches: true, actorRef: CARD_TEST_OWNER_REF });
      const fx = new CardSyncFixtures(db, Date.parse(CARD_TEST_T0));
      const g = fx.graph(account);
      const { deviceId } = fx.pairedDevice(g, 'approved');
      fx.grant(g, deviceId, { consent: true });
      fx.preparedPlan(g, fx.extensionSet(g, deviceId));
      fx.auditEvent(g, CARD_TEST_T0);
      const populated = NEW_TABLES.filter((table) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n > 0);
      expect(populated.length).toBeGreaterThanOrEqual(19);
      for (const table of populated) {
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        for (const { column, label, value, message } of cases(table)) {
          expect(raised(() => db.prepare(`UPDATE ${table} SET "${column}" = ?`).run(value)), `${table}.${column}: ${label}`).toBe(message);
        }
        expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table).toEqual(rows);
      }
    } finally {
      repo.close();
    }
  });
});

describe('card guards: the stored revision, read from a window around its marker (P6)', () => {
  const newer = (label: string) => `card guards are revision ${label}, newer than this build's ${GUARD_REVISION}; refusing to ` +
    'open the database. Run the newer build, or restore a backup made by this one.';
  const withTrigger = (sql: string) => {
    const file = path.join(dir, 'revision.db');
    open(file).close();
    withRaw(file, (db) => db.exec(sql));
    return file;
  };
  const trigger = (comment: string) => `CREATE TRIGGER trg_card_accounts_audit_note AFTER UPDATE ON card_accounts\n${comment}BEGIN SELECT 1; END`;
  const refusal = (file: string) => {
    const state = fileState(file);
    let message = 'opened';
    try {
      open(file).close();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(fileState(file)).toEqual(state);
    return message;
  };

  /** A trigger stored byte for byte as given (through writable_schema), as a client sending raw bytes could leave it. */
  const withStoredTrigger = (bytes: Buffer) => {
    const file = path.join(dir, 'revision.db');
    open(file).close();
    withRaw(file, (db) => {
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare(`INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql)
        VALUES ('trigger', 'trg_card_accounts_audit_note', 'card_accounts', 0, CAST(? AS TEXT))`).run(bytes);
      db.pragma('writable_schema = OFF');
      db.unsafeMode(false);
    });
    return file;
  };
  const body = 'CREATE TRIGGER trg_card_accounts_audit_note AFTER UPDATE ON card_accounts BEGIN SELECT 1; END';

  it.each<[string, Buffer, string]>([
    ['a NUL right after a revision line', Buffer.from(`${body}\n-- holdr card guard revision 7\0garbage`), 'opened'],
    ['a NUL, then a revision line', Buffer.from(`${body}\n-- holdr card guard revision 1\0\n-- holdr card guard revision 9\n`),
      newer('9')],
    // 40 stray UTF-8 continuation bytes, then a line "5" and a line break placed where a reader counting characters
    // instead of bytes would look for the revision; the only revision line says 4, this build's.
    ['malformed UTF-8 before the revision line', Buffer.concat([
      Buffer.from('CREATE TRIGGER trg_card_accounts_audit_note AFTER UPDATE ON card_accounts\n-- '), Buffer.alloc(40, 0x80),
      Buffer.from(`\n--${'x'.repeat(27)}5\n--${'y'.repeat(6)}\n-- holdr card guard revision 4\nBEGIN SELECT 1; END`),
    ]), 'opened'],
  ])('reads a trigger stored with %s exactly as the revision line\'s regular expression does', (_label, bytes, expected) => {
    expect(refusal(withStoredTrigger(bytes))).toBe(expected);
  });

  it.each<[string, string, string]>([
    ['an exact revision line', '-- holdr card guard revision 9\n', newer('9')],
    ['a revision line ending in CRLF', '-- holdr card guard revision 7\r\n', newer('7')],
    ['a marker inside a line, then a revision line', '-- note: -- holdr card guard revision 99\n-- holdr card guard revision 8\n', newer('8')],
    ['a marker without digits, then a revision line', '-- holdr card guard revision next\n-- holdr card guard revision 6\n', newer('6')],
    ['a revision with more digits than the window', `-- holdr card guard revision ${'9'.repeat(30)}\n`, newer('1000 or higher')],
    ['a marker that is no revision line', '-- holdr card guard revision 9 beta\n', 'opened'],
  ])('reads %s exactly as the revision line\'s regular expression does', (_label, comment, expected) => {
    expect(refusal(withTrigger(trigger(comment)))).toBe(expected);
  });
});
