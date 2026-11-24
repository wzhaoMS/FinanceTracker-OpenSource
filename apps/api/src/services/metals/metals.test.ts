import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  METALS_GUARD_EVIDENCE,
  METALS_HOLD_REASONS,
  METALS_PREMIUM_BASES,
  METALS_PRODUCT_REF_MAX,
  METALS_RETAIL_FORMATS,
  METALS_RETAIL_POLICIES,
  METALS_RULES,
  METALS_TITLE_GUARD,
  metalsEffectiveSkeleton,
  type MetalsBullionAnswer,
  type MetalsCompetitor,
  type MetalsContentDecision,
  type MetalsEvent,
  type MetalsImportPayload,
  type MetalsLineMetalUncertain,
  type MetalsOrder,
} from '@finance-tracker/shared/metals-ledger';
import {
  delivered,
  metalItem,
  otherItem,
  syntheticCompetitor,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
  type SyntheticLineInput,
} from '@finance-tracker/shared/metals-ledger-fixtures';

import { installCheckingSchema } from '../checking/schema.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../../testing/scratchDir.js';
import { tablesAndCounts } from '../../testing/sqliteContents.js';
import { formatMetalsReport, metalsReport, type MetalsReport } from '../../cli/metalsReport.js';
import { METALS_SCHEMA_V1 } from './schemaV1.js';
import { METALS_SCHEMA_INTERIM_V0 } from './schemaInterimV0.js';
import { METALS_INTERIM_V0_DIGEST, metalsInterimObjects, planMetalsReinstall } from './reinstall.js';
import {
  METALS_BIRTH_STATE_TRIGGERS,
  METALS_GUARD_EVIDENCE_LISTS,
  METALS_PROTECTED,
  METALS_SCHEMA_DIGEST,
  METALS_SCHEMA_SQL,
  METALS_TABLES,
  MetalsRefusal,
  approveMetalsBindings,
  canonicalMetalsOrder,
  fencedMetalsWrite,
  classifyMetalsVersion,
  importMetalsPayload,
  installMetalsSchema,
  lettersOfHex,
  metalsColumnsOf,
  metalsFreeTextProblems,
  metalsOrderDigest,
  metalsPayloadSha256,
  metalsSchemaObjects,
  metalsSchemaState,
  metalsSqlDigest,
  normalizeMetalsSql,
  planMetalsBindingApproval,
  planMetalsBindingRevocation,
  planMetalsImport,
  planMetalsSupersede,
  proposeMetalsBindings,
  revokeMetalsBindings,
  serializeMetalsBindingProposal,
  sha256Hex,
  supersedeMetalsVersions,
  validMetalsBindingProposal,
  type MetalsAccountChoice,
  type MetalsBindingPair,
} from './index.js';

// Synthetic only: a database made by this build in a scratch directory, invented orders, amounts, last 4s and GO ids.

const NOW = '2030-03-01T12:00:00.000Z';
const DATABASE_REF = 'c'.repeat(64);
const goId = () => randomBytes(16).toString('hex');
const ctx = (planDigest: string | null = null) => ({ now: NOW, goId: goId(), purpose: 'copy-rehearsal' as const, planDigest });
const importCtx = (payload: unknown, planDigest: string | null = null) => ({ ...ctx(planDigest), inputSha256: metalsPayloadSha256(payload) });
let template: string, dir: string, file: string, db: Database.Database;

/** The refusal a call meets: its code and details, or null when it returns. */
const refusalOf = (fn: () => unknown): { code: string; details: Record<string, unknown> } | null => {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof MetalsRefusal)) throw error;
    return { code: error.code, details: error.details };
  }
  return null;
};

const shipped = (date: string): MetalsEvent => ({ kind: 'shipped', date, dateBasis: 'stated', quantity: 1, occurrence: 1 });

interface WalmartOptions {
  events?: MetalsEvent[];
  massBasis?: 'fine' | 'unknown';
  quantity?: number;
  date?: string;
  last4?: string;
  refunded?: boolean;
}

function walmartOrder(id: number, options: WalmartOptions = {}): MetalsOrder {
  const quantity = options.quantity ?? 1;
  const amount = 200000 * quantity;
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date: options.date ?? '2030-01-10',
    skeleton: [metalItem(0, amount)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: options.last4 ?? '1111', amountMinor: amount }],
      refunded: options.refunded ?? false, cancelled: false, partlyCancelled: false, grossTotalMinor: amount,
    },
    refunds: options.refunded ? [{ amountMinor: -1000, date: '2030-01-20' }] : [],
    lines: [{
      ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', productRef: 'walmart:100001', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'ozt' }, pack: 'single', purity: { text: '.9999', value: '9999/10000' },
      massBasis: options.massBasis ?? 'fine', design: null, quantity, unitPriceMinor: 200000,
      events: options.events ?? [shipped('2030-01-11'), delivered(quantity, '2030-01-14')], seller: 'Sample Bullion Shop',
    }],
  });
}

function collectpureSale(id: number, status: 'agreed' | 'complete' = 'complete'): MetalsOrder {
  const payout = { key: syntheticKey('collectpure', 'payout', id), method: 'ach' as const, destinationLast4: '2222', amountMinor: 209000,
    initiatedDate: '2030-02-09', payoutDate: status === 'complete' ? '2030-02-10' : null, status: status === 'complete' ? 'complete' as const : 'pending' as const };
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date: '2030-02-01', status, completedDate: status === 'complete' ? '2030-02-10' : null,
    skeleton: [metalItem(0, 210000)],
    components: [{ kind: 'platform-fee', amountMinor: -1000 }],
    payouts: [payout],
    lines: [{
      ordinal: 0, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'collectpure:SKU-EAGLE', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1, unitPriceMinor: 210000,
      events: [{ kind: 'agreed', date: '2030-02-01', dateBasis: 'stated', quantity: 1, occurrence: 1 }],
    }],
  });
}

const competitor = (id: number, last4 = '1111'): MetalsCompetitor => syntheticCompetitor('walmart', 'online', id, '2030-01-12', {
  fulfilment: { shipments: 2 }, methods: [{ kind: 'card', network: 'visa', last4, amountMinor: 50000 }],
  refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 50000,
});

function walmartPayload(orders: MetalsOrder[], options: { folder?: string; competitors?: MetalsCompetitor[]; capture?: string; capturedAt?: string } = {}):
  MetalsImportPayload {
  const payload = syntheticPayload('walmart', {
    orders, competitors: options.competitors ?? [],
    held: [{ key: syntheticKey('walmart', 'order', 'held-1'), channel: 'online', date: '2030-01-05', reason: 'field-unsupported', check: 'driver-tip' }],
    coverage: [syntheticCoverage('online', '2030-01-01', '2030-01-31', null, orders.length)],
  });
  payload.account.folder = options.folder ?? 'walmart';
  if ('captureDigest' in payload.input) {
    payload.input.captureDigest = (options.capture ?? 'b').repeat(64);
    if (options.capturedAt) payload.input.capturedAt = options.capturedAt;
  }
  return payload;
}

/** A capture time on a synthetic day of February 2030, at noon UTC. */
const capturedOn = (day: number) => `2030-02-${String(day).padStart(2, '0')}T12:00:00Z`;

const count = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
const anImport = (payload: MetalsImportPayload, account: MetalsAccountChoice) => importMetalsPayload(db, { payload, account }, importCtx(payload));

beforeAll(async () => {
  template = await makeScratchDir('metals-template-');
  const repo = new SqliteStateRepo({ file: path.join(template, 'finance.db') });
  repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1111', currency: 'USD' });
  repo.close();
  const handle = new Database(path.join(template, 'finance.db'));
  try { handle.pragma('wal_checkpoint(TRUNCATE)'); } finally { handle.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  dir = await makeScratchDir('metals-service-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
  db = new Database(file);
  db.pragma('foreign_keys = ON');
});
afterEach(async () => {
  db.close();
  await removeScratchDir(dir);
});

describe('metals schema', () => {
  it('is absent on a database this build made (nothing at boot), present once installed, and installs once', () => {
    expect(metalsSchemaState(db)).toBe('absent');
    installMetalsSchema(db);
    expect(metalsSchemaState(db)).toBe('present');
    expect(METALS_TABLES).toHaveLength(17);
    for (const table of METALS_TABLES) expect(count(`SELECT count(*) FROM ${table}`)).toBe(0);
    installMetalsSchema(db);
    expect(metalsSchemaState(db)).toBe('present');
    expect(METALS_SCHEMA_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates exactly version 1, the frozen statement list and digest of the one install (the upgrade design\'s ratchet)', () => {
    // Any change to a generated statement fails here until a new version is registered (upgrade design §1.3, ROOT).
    expect(METALS_SCHEMA_V1.version).toBe(1);
    expect(metalsSqlDigest(METALS_SCHEMA_V1.statements)).toBe(METALS_SCHEMA_V1.digest);
    expect(METALS_SCHEMA_SQL).toEqual(METALS_SCHEMA_V1.statements);
    expect(METALS_SCHEMA_DIGEST).toBe(METALS_SCHEMA_V1.digest);
  });

  it('freezes the interim v0 shape apart from version 1, which reads it as a conflict that only plan and reinstall recognize', () => {
    // Track B's v0 (ROOT's ruling 1), byte for byte the earlier version 1: its digest is pinned, and it is never this build's.
    expect(METALS_SCHEMA_INTERIM_V0.version).toBe(0);
    expect(METALS_SCHEMA_INTERIM_V0.digest).toBe('f5f9d9b38e81dea56e2d4b4c5a3961467470ab78706910b5d4b61a98cedeb607');
    expect(metalsSqlDigest(METALS_SCHEMA_INTERIM_V0.statements)).toBe(METALS_SCHEMA_INTERIM_V0.digest);
    expect(METALS_INTERIM_V0_DIGEST).toBe(METALS_SCHEMA_INTERIM_V0.digest);
    expect(METALS_SCHEMA_INTERIM_V0.digest).not.toBe(METALS_SCHEMA_DIGEST);
    expect(Object.isFrozen(METALS_SCHEMA_INTERIM_V0) && Object.isFrozen(METALS_SCHEMA_INTERIM_V0.statements)).toBe(true);
    const objects = metalsInterimObjects();
    expect(objects.tables).toEqual(METALS_TABLES);
    expect(objects.tables.length + objects.indexes.length + objects.triggers.length).toBe(METALS_SCHEMA_INTERIM_V0.statements.length);
    expect(planMetalsReinstall(db)).toBeNull();
    for (const sql of METALS_SCHEMA_INTERIM_V0.statements) db.exec(sql);
    expect(metalsSchemaState(db)).toBe('conflict');
    expect(() => installMetalsSchema(db)).toThrow(/another shape/);
    const plan = planMetalsReinstall(db);
    expect(plan).toEqual({
      from: { digest: METALS_INTERIM_V0_DIGEST, objects: 84 }, to: { digest: METALS_SCHEMA_DIGEST, objects: 84 },
      counts: Object.fromEntries(METALS_TABLES.map((table) => [table, 0])), activeBindings: { card: 0, checking: 0 },
    });
  });

  it('classifies any other metals_ object as a conflict and never installs over it', () => {
    db.exec('CREATE TABLE metals_accounts (id TEXT)');
    expect(metalsSchemaState(db)).toBe('conflict');
    expect(() => installMetalsSchema(db)).toThrow(/another shape/);
    db.exec('DROP TABLE metals_accounts');
    installMetalsSchema(db);
    db.exec('CREATE TABLE Metals_Extra (id TEXT)');
    expect(metalsSchemaState(db)).toBe('conflict');
    db.exec('DROP TABLE Metals_Extra');
    db.exec('CREATE INDEX extra_index ON metals_lots (title)');
    expect(metalsSchemaState(db)).toBe('conflict');
  });

  it('compares statements with their quoted text kept exactly: a declaration changed inside a literal is a conflict (review P299-2)', () => {
    expect(normalizeMetalsSql("  CHECK (label   NOT GLOB '*  *')\n")).toBe("CHECK (label NOT GLOB '*  *')");
    expect(normalizeMetalsSql("x = 'it''s  two'\t AND \"a  b\" = [c  d] AND `e  f` = 'g'")).toBe("x = 'it''s  two' AND \"a  b\" = [c  d] AND `e  f` = 'g'");
    expect(normalizeMetalsSql("x = 'unterminated  ")).toBe("x = 'unterminated  ");
    const changed = METALS_SCHEMA_SQL.map((sql) => sql.replace("label NOT GLOB '*  *'", "label NOT GLOB '* *'"));
    expect(changed.filter((sql, index) => sql !== METALS_SCHEMA_SQL[index])).toHaveLength(1);
    expect(metalsSqlDigest(METALS_SCHEMA_SQL)).toBe(METALS_SCHEMA_DIGEST);
    expect(metalsSqlDigest(changed)).not.toBe(METALS_SCHEMA_DIGEST);
    for (const sql of changed) db.exec(sql);
    expect(metalsSchemaState(db)).toBe('conflict');
    expect(metalsSchemaObjects(db)).toMatchObject({ differing: 1, missing: 0, unexpected: 0 });
    expect(() => installMetalsSchema(db)).toThrow(/another shape/);
    // A valid label with one space would fail the changed CHECK mid-write: every writer refuses first, before any write.
    const payload = walmartPayload([walmartOrder(1)]);
    expect(refusalOf(() => planMetalsImport(db, { payload, account: { label: 'Walmart account' } }))?.code).toBe('metals-conflict');
    expect(refusalOf(() => importMetalsPayload(db, { payload, account: { label: 'Walmart account' } }, importCtx(payload)))?.code)
      .toBe('metals-conflict');
    for (const table of METALS_TABLES) expect(count(`SELECT count(*) FROM ${table}`), table).toBe(0);
  });

  it('keeps versions and observations append-only and refuses a stray state change', () => {
    installMetalsSchema(db);
    anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    expect(() => db.prepare('DELETE FROM metals_order_versions').run()).toThrow();
    expect(() => db.prepare(`UPDATE metals_order_versions SET digest = ?`).run('a'.repeat(64))).toThrow();
    expect(() => db.prepare(`UPDATE metals_order_versions SET state = 'proposed'`).run()).toThrow();
    expect(() => db.prepare(`UPDATE metals_observations SET outcome = 'conflict'`).run()).toThrow();
    expect(() => db.prepare('DELETE FROM metals_imports').run()).toThrow();
  });

  it('holds every hold reason and refuses a long digit run in free text', () => {
    installMetalsSchema(db);
    const held = METALS_HOLD_REASONS.map((reason, index) => ({ key: syntheticKey('walmart', 'order', `held-${index}`), channel: 'online' as const,
      date: null, reason, check: 'synthetic-check' }));
    const payload = { ...walmartPayload([]), held };
    const created = anImport(payload, { label: 'Walmart account' });
    expect(created.held).toBe(METALS_HOLD_REASONS.length);
    anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), { accountId: created.accountId! });
    expect(() => db.prepare('UPDATE metals_lots SET title = ?').run('Bar 1234567890123')).toThrow();
  });

  it('refuses a long digit run in any free text nested in a stored aggregate, but not in a computed fine-content rational', () => {
    installMetalsSchema(db);
    const created = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const stored = JSON.parse(db.prepare('SELECT canonical_json FROM metals_order_versions').pluck().get() as string) as MetalsOrder;
    const LONG = '1234567890123';
    let version = 1;
    const insert = (order: unknown) => db.prepare(`INSERT INTO metals_order_versions (order_key, version, source, side, digest, canonical_json, state,
      reason, created_by_import, created_at) VALUES (?, ?, 'walmart', 'buy', ?, ?, 'conflict', 'conflict', ?, ?)`)
      .run(stored.key, ++version, 'a'.repeat(64), JSON.stringify(order), created.importId, NOW);
    const withLine = (patch: Record<string, unknown>) => ({ ...stored, lines: [{ ...stored.lines[0], ...patch }] });
    const nested = [
      withLine({ title: `Sample Gold Bar ${LONG}` }), withLine({ productRef: `walmart:${LONG}` }), withLine({ seller: `Sample Shop ${LONG}` }),
      withLine({ sale: { program: `Program ${LONG}`, premium: null, inspection: null } }),
      withLine({ sale: { program: null, premium: { text: `${LONG} over spot`, basis: 'per-oz' }, inspection: null } }),
      withLine({ fine: { hold: 'mass', missing: [`mass ${LONG}`] } }),
    ];
    for (const order of nested) expect(() => insert(order)).toThrow(/long digit run/);
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(1);
    insert(withLine({ fine: { ...stored.lines[0].fine, troyOz: `${LONG}${LONG}/7` } }));
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(2);
  });
});

describe('metals corrections storage (corrections r6 §4)', () => {
  beforeEach(() => installMetalsSchema(db));
  const letters = (length: number) => lettersOfHex(randomBytes(length / 2).toString('hex'));
  const rowOf = (table: string, where = '1', ...args: unknown[]) =>
    db.prepare(`SELECT rowid AS rowid, * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT 1`).get(...args) as Record<string, unknown>;
  const nextRowid = (table: string) => count(`SELECT coalesce(max(rowid), 0) + 1 FROM ${table}`);
  /** Inserts a row like a stored one, with `patch` applied; an undefined value leaves its column out. */
  const insertLike = (table: string, row: Record<string, unknown>, patch: Record<string, unknown> = {}, verb = 'INSERT') => {
    const entries = Object.entries({ ...row, ...patch }).filter(([, value]) => value !== undefined);
    return db.prepare(`${verb} INTO ${table} (${entries.map(([column]) => column).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`)
      .run(...entries.map(([, value]) => value));
  };
  const update = (table: string, fields: Record<string, unknown>, where: string, ...args: unknown[]) =>
    db.prepare(`UPDATE ${table} SET ${Object.keys(fields).map((column) => `${column} = ?`).join(', ')} WHERE ${where}`).run(...Object.values(fields), ...args);
  const decision = (patch: Record<string, unknown> = {}) => ({
    decision_id: `mtl-dec-${letters(32)}`, kind: 'bullion', scope: 'product', product_ref: 'walmart:100001', fingerprint: letters(64), answer: 'bullion',
    preview_digest: letters(64), decided_at: NOW, decided_by: `usr_${letters(32)}`, ...patch,
  });
  const voidFields = (reason = 'wrong-payload', under = 'import-wrong-payload') => ({
    voided_by_go: letters(32), voided_at: NOW, void_reason: reason, voided_under_marker: letters(64), voided_under_reason: under,
  });
  const failedCheck = /CHECK constraint failed/;

  it('guards every unique key of every protected table, from one declaration, and reads each column list exactly', () => {
    const asKeys = (keys: Array<{ columns: readonly string[]; partial: boolean }>) => keys.map((key) => JSON.stringify(key)).sort();
    for (const { table, keys, unset, bornPast } of METALS_PROTECTED) {
      expect(metalsColumnsOf(table), table).toEqual(db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').pluck().all(table));
      const unique = (db.prepare('SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1').all(table) as Array<{ name: string; partial: number }>)
        .map(({ name, partial }) => ({ columns: db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').pluck().all(name) as string[],
          partial: partial === 1 }));
      expect(asKeys(unique), table).toEqual(asKeys(keys.map(({ columns, index }) => ({ columns, partial: index !== undefined }))));
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).pluck().all(table), table).toEqual(expect.arrayContaining([
        `${table}_insert_keys`, `${table}_rowid_domain`, ...(unset.length > 0 || bornPast !== undefined ? [`${table}_insert_unset`] : [])]));
    }
    // Every table a no-update, one-way or no-delete trigger protects is declared, so none is left without its guards.
    const guarded = db.prepare(`SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'metals\\_%' ESCAPE '\\'
      AND (sql LIKE '%BEFORE UPDATE ON%' OR sql LIKE '%BEFORE DELETE ON%')`).pluck().all() as string[];
    expect([...guarded].sort()).toEqual(METALS_PROTECTED.map(({ table }) => table).sort());
    expect(METALS_BIRTH_STATE_TRIGGERS).toEqual(['metals_accounts_insert_unset', 'metals_imports_insert_unset', 'metals_order_versions_insert_unset',
      'metals_owner_decisions_insert_unset', 'metals_imports_payload_admission']);
    for (const name of METALS_BIRTH_STATE_TRIGGERS) expect(count(`SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?`, name)).toBe(1);
  });

  it('refuses INSERT OR REPLACE on each unique key and on the rowid of every protected table, with foreign keys and recursive triggers off', () => {
    anImport(walmartPayload([walmartOrder(1)], { competitors: [competitor(77)] }), { label: 'Walmart account' });
    insertLike('metals_owner_decisions', decision(), { rowid: 1 });
    db.pragma('foreign_keys = OFF');
    db.pragma('recursive_triggers = OFF');
    const stored = (table: string) => JSON.stringify(db.prepare(`SELECT rowid AS rowid, * FROM ${table} ORDER BY rowid`).all());
    const before = new Map(METALS_PROTECTED.map(({ table }) => [table, stored(table)]));
    const account = rowOf('metals_accounts');
    const imported = rowOf('metals_imports');
    const version = rowOf('metals_order_versions');
    const observation = rowOf('metals_observations');
    const seen = rowOf('metals_competitor_observations');
    const owner = rowOf('metals_owner_decisions');
    const next = nextRowid;
    // Each stored row as it is (every key and the rowid at once), then each key alone, then the rowid alone.
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['metals_accounts', account, {}],
      ['metals_accounts', account, { rowid: next('metals_accounts'), folder: 'walmart-2' }],
      ['metals_accounts', account, { rowid: next('metals_accounts'), account_id: `mtl-acct-${letters(32)}` }],
      ['metals_accounts', account, { account_id: `mtl-acct-${letters(32)}`, folder: 'walmart-3' }],
      ['metals_imports', imported, {}],
      ['metals_imports', imported, { rowid: next('metals_imports'), import_seq: 99, payload_sha256: letters(64) }],
      ['metals_imports', imported, { rowid: next('metals_imports'), import_id: `mtl-imp-${letters(32)}`, payload_sha256: letters(64) }],
      ['metals_imports', imported, { rowid: next('metals_imports'), import_id: `mtl-imp-${letters(32)}`, import_seq: 99 }],
      ['metals_imports', imported, { import_id: `mtl-imp-${letters(32)}`, import_seq: 99, payload_sha256: letters(64) }],
      ['metals_order_versions', version, {}],
      ['metals_order_versions', version, { rowid: next('metals_order_versions'), state: 'conflict', reason: 'conflict' }],
      ['metals_order_versions', version, { rowid: next('metals_order_versions'), version: 2, reason: 'progression' }],
      ['metals_order_versions', version, { version: 3, state: 'conflict', reason: 'conflict' }],
      ['metals_observations', observation, {}],
      ['metals_observations', observation, { rowid: next('metals_observations') }],
      ['metals_observations', observation, { import_id: `mtl-imp-${letters(32)}` }],
      ['metals_competitor_observations', seen, {}],
      ['metals_competitor_observations', seen, { rowid: next('metals_competitor_observations') }],
      ['metals_competitor_observations', seen, { import_id: `mtl-imp-${letters(32)}` }],
      ['metals_owner_decisions', owner, {}],
      ['metals_owner_decisions', owner, { rowid: next('metals_owner_decisions'), fingerprint: letters(64) }],
      ['metals_owner_decisions', owner, { rowid: next('metals_owner_decisions'), decision_id: `mtl-dec-${letters(32)}` }],
      ['metals_owner_decisions', owner, { decision_id: `mtl-dec-${letters(32)}`, fingerprint: letters(64) }],
    ];
    for (const [table, row, patch] of cases) {
      expect(() => insertLike(table, row, patch, 'INSERT OR REPLACE'), `${table} ${Object.keys(patch).join(',')}`)
        .toThrow(/would replace a stored one|metals-payload-barred/);
    }
    for (const { table } of METALS_PROTECTED) expect(stored(table), table).toBe(before.get(table));
  });

  it('keeps every protected rowid positive, and gives a row inserted without one a fresh rowid', () => {
    anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const account = rowOf('metals_accounts');
    for (const rowid of [0, -5]) {
      expect(() => insertLike('metals_accounts', account, { rowid, account_id: `mtl-acct-${letters(32)}`, folder: 'walmart-2' })).toThrow(/rowid is positive/);
    }
    insertLike('metals_accounts', account, { rowid: undefined, account_id: `mtl-acct-${letters(32)}`, folder: 'walmart-2' });
    expect(db.prepare('SELECT rowid FROM metals_accounts ORDER BY rowid').pluck().all()).toEqual([1, 2]);
  });

  it('starts every protected row before its one-way changes: unvoided, unretired, unresolved and unchosen, unrevoked', () => {
    const first = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const born = /starts before its one-way changes/;
    const imported = rowOf('metals_imports');
    const freshImport = { rowid: nextRowid('metals_imports'), import_id: `mtl-imp-${letters(32)}`, import_seq: 2, payload_sha256: letters(64) };
    expect(() => insertLike('metals_imports', imported, { ...freshImport, ...voidFields() })).toThrow(born);
    expect(() => insertLike('metals_imports', imported, { ...freshImport, ...voidFields(), voided_for_import: first.importId })).toThrow(born);
    expect(() => insertLike('metals_accounts', rowOf('metals_accounts'), { rowid: nextRowid('metals_accounts'), account_id: `mtl-acct-${letters(32)}`,
      folder: 'walmart-2', retired_by_import: first.importId })).toThrow(born);
    const version = rowOf('metals_order_versions');
    const freshVersion = { rowid: nextRowid('metals_order_versions'), version: 2, state: 'conflict', reason: 'conflict' };
    expect(() => insertLike('metals_order_versions', version, { ...freshVersion, state: 'superseded', resolution: 'declined', resolved_by_go: letters(32),
      resolved_at: NOW })).toThrow(born);
    expect(() => insertLike('metals_order_versions', version, { ...freshVersion, chosen_by_go: letters(32), chosen_at: NOW, chosen_seq: 1 })).toThrow(born);
    expect(() => insertLike('metals_owner_decisions', decision({ revoked_at: NOW, revoked_by: `usr_${letters(32)}` }), { rowid: 1 })).toThrow(born);
    insertLike('metals_order_versions', version, freshVersion);
    insertLike('metals_owner_decisions', decision(), { rowid: 1 });
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(2);
  });

  it('voids an import once, retires an account only as its void authorized, revokes a decision once, and deletes nothing', () => {
    const first = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const second = anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), { accountId: first.accountId! });
    const oneVoid = /changes only by its one void/;
    expect(() => update('metals_imports', { voided_by_go: letters(32) }, 'import_id = ?', second.importId)).toThrow(oneVoid);
    expect(() => update('metals_imports', { ...voidFields(), import_seq: 9 }, 'import_id = ?', second.importId)).toThrow(oneVoid);
    expect(() => update('metals_imports', { ...voidFields(), rowid: 9 }, 'import_id = ?', second.importId)).toThrow(oneVoid);
    update('metals_imports', voidFields(), 'import_id = ?', second.importId);
    expect(() => update('metals_imports', { voided_at: '2030-03-02T12:00:00.000Z' }, 'import_id = ?', second.importId)).toThrow(oneVoid);
    expect(() => update('metals_imports', { voided_for_import: first.importId }, 'import_id = ?', second.importId)).toThrow(oneVoid);
    expect(() => db.prepare('DELETE FROM metals_imports WHERE import_id = ?').run(second.importId)).toThrow();

    const retire = /changes only by its one retirement/;
    expect(() => update('metals_accounts', { retired_by_import: second.importId }, 'account_id = ?', first.accountId)).toThrow(retire);
    update('metals_imports', { ...voidFields('wrong-account', 'import-wrong-account'), retire_account_id: first.accountId }, 'import_id = ?', first.importId);
    expect(() => update('metals_accounts', { retired_by_import: first.importId, label: 'Other account' }, 'account_id = ?', first.accountId)).toThrow(retire);
    update('metals_accounts', { retired_by_import: first.importId }, 'account_id = ?', first.accountId);
    expect(() => update('metals_accounts', { retired_by_import: null }, 'account_id = ?', first.accountId)).toThrow(retire);
    expect(() => update('metals_accounts', { retired_by_import: second.importId }, 'account_id = ?', first.accountId)).toThrow(retire);
    expect(() => db.prepare('DELETE FROM metals_accounts').run()).toThrow();
    // A retired account frees its folder for one new live account, and only one.
    const liveAgain = () => insertLike('metals_accounts', rowOf('metals_accounts'), { rowid: nextRowid('metals_accounts'),
      account_id: `mtl-acct-${letters(32)}`, retired_by_import: null });
    liveAgain();
    expect(() => liveAgain()).toThrow(/would replace a stored one/);

    const revoke = /changes only by its one revoke/;
    const owner = decision();
    insertLike('metals_owner_decisions', owner, { rowid: 1 });
    expect(() => update('metals_owner_decisions', { answer: 'not-bullion' }, 'decision_id = ?', owner.decision_id)).toThrow(revoke);
    expect(() => update('metals_owner_decisions', { revoked_at: NOW, revoked_by: owner.decided_by, answer: 'not-bullion' }, 'decision_id = ?',
      owner.decision_id)).toThrow(revoke);
    update('metals_owner_decisions', { revoked_at: NOW, revoked_by: owner.decided_by }, 'decision_id = ?', owner.decision_id);
    expect(() => update('metals_owner_decisions', { revoked_at: null, revoked_by: null }, 'decision_id = ?', owner.decision_id)).toThrow(revoke);
    expect(() => db.prepare('DELETE FROM metals_owner_decisions').run()).toThrow();
    // A revoked decision frees its key for a new live one.
    insertLike('metals_owner_decisions', decision({ fingerprint: owner.fingerprint }), { rowid: 2 });
    expect(count('SELECT count(*) FROM metals_owner_decisions')).toBe(2);
  });

  it('lets bytes an earlier import carried return only as the correction of a collateral void of the same live account', () => {
    const p1 = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const account = { accountId: p1.accountId! };
    const p2 = anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), account);
    const p3 = anImport(walmartPayload([walmartOrder(3)], { capture: 'd' }), account);
    const other = anImport(walmartPayload([walmartOrder(4)], { capture: 'e', folder: 'walmart-2' }), { label: 'Second account' });
    const original = new Map([p1, p2, p3].map((receipt) => [receipt.importId!, rowOf('metals_imports', 'import_id = ?', receipt.importId)]));
    const again = (importId: string, patch: Record<string, unknown> = {}) => insertLike('metals_imports', original.get(importId)!, {
      rowid: nextRowid('metals_imports'), import_id: `mtl-imp-${letters(32)}`, import_seq: count('SELECT max(import_seq) + 1 FROM metals_imports'), ...patch });
    const barred = /metals-payload-barred/;
    expect(() => again(p1.importId!, { corrects_import: p1.importId })).toThrow(/metals-payload-barred|would replace a stored one/);
    // A void that cleared nothing bars its bytes for good.
    update('metals_imports', voidFields(), 'import_id = ?', p1.importId);
    expect(() => again(p1.importId!, { corrects_import: p1.importId })).toThrow(barred);
    // A collateral void's bytes return only as the correction naming it, into the same account.
    update('metals_imports', { ...voidFields(), voided_for_import: p3.importId }, 'import_id = ?', p2.importId);
    expect(() => again(p2.importId!)).toThrow(barred);
    expect(() => again(p2.importId!, { corrects_import: p1.importId })).toThrow(barred);
    expect(() => again(p2.importId!, { corrects_import: p2.importId, account_id: other.accountId })).toThrow(barred);
    again(p2.importId!, { corrects_import: p2.importId });
    expect(count('SELECT count(*) FROM metals_imports WHERE payload_sha256 = ?', original.get(p2.importId!)!.payload_sha256)).toBe(2);
    // ... and never once that account is retired.
    update('metals_imports', { ...voidFields(), voided_for_import: p1.importId }, 'import_id = ?', p3.importId);
    const correction = db.prepare('SELECT import_id FROM metals_imports WHERE corrects_import = ?').pluck().get(p2.importId) as string;
    update('metals_imports', { ...voidFields('wrong-account', 'import-wrong-account'), retire_account_id: p1.accountId }, 'import_id = ?', correction);
    update('metals_accounts', { retired_by_import: correction }, 'account_id = ?', p1.accountId);
    expect(() => again(p3.importId!, { corrects_import: p3.importId })).toThrow(barred);
  });

  it('stores renewed and reinstated versions, choices with their sequence, progressions with what they replace, and bullion answers, as declared', () => {
    const first = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const second = anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), { accountId: first.accountId! });
    const key = walmartOrder(1).key;
    const version = rowOf('metals_order_versions', 'order_key = ? AND version = 1', key);
    const pending = (patch: Record<string, unknown>) => insertLike('metals_order_versions', version, { rowid: nextRowid('metals_order_versions'),
      version: 2, state: 'conflict', reason: 'conflict', ...patch });
    const at = (n: number) => `order_key = '${key}' AND version = ${n}`;
    expect(() => pending({ order_key: `walmart-order-${letters(64)}`, version: 1, state: 'active', reason: 'renewed' })).toThrow(failedCheck);
    expect(() => pending({ reason: 'reinstated' })).toThrow(failedCheck);
    expect(() => pending({ reason: 'reinstated', reinstates_version: 1 })).toThrow(failedCheck);
    expect(() => pending({ reason: 'reinstated', reinstates_version: 2, reinstated_by_go: letters(32) })).toThrow(failedCheck);
    expect(() => pending({ reinstates_version: 1, reinstated_by_go: letters(32) })).toThrow(failedCheck);
    pending({ reason: 'reinstated', reinstates_version: 1, reinstated_by_go: letters(32) });
    // A pending version may end voided, by a GO.
    pending({ version: 3 });
    expect(() => update('metals_order_versions', { state: 'superseded', resolution: 'voided', resolved_at: NOW }, at(3))).toThrow(failedCheck);
    update('metals_order_versions', { state: 'superseded', resolution: 'voided', resolved_by_go: letters(32), resolved_at: NOW }, at(3));
    // A choice carries the sequence of the newest import when it was made, set with it and fixed with it.
    pending({ version: 4 });
    update('metals_order_versions', { state: 'superseded', resolution: 'replaced', resolved_by_go: letters(32), resolved_at: NOW }, at(1));
    expect(() => update('metals_order_versions', { state: 'active', chosen_by_go: letters(32), chosen_at: NOW }, at(4))).toThrow(failedCheck);
    update('metals_order_versions', { state: 'active', chosen_by_go: letters(32), chosen_at: NOW, chosen_seq: 2 }, at(4));
    expect(() => update('metals_order_versions', { chosen_seq: 3 }, at(4))).toThrow(/keeps the GO that chose it|state change refused/);

    // An observation names the version a progression replaced, and only a progression.
    const observation = rowOf('metals_observations', 'import_id = ? AND order_key = ?', first.importId, key);
    const observe = (patch: Record<string, unknown>) => insertLike('metals_observations', observation, { rowid: nextRowid('metals_observations'),
      import_id: second.importId, ...patch });
    expect(() => observe({ outcome: 'progression', version: 2 })).toThrow(failedCheck);
    expect(() => observe({ outcome: 'observation', version: 2, replaces_version: 1 })).toThrow(failedCheck);
    expect(() => observe({ outcome: 'progression', version: 2, replaces_version: 2 })).toThrow(failedCheck);
    observe({ outcome: 'progression', version: 2, replaces_version: 1 });

    // A bullion answer is one of the two, about a product or a lot (pinned to its evidence), and carries nothing else.
    const decide = (patch: Record<string, unknown>) => insertLike('metals_owner_decisions', decision(patch), { rowid: nextRowid('metals_owner_decisions') });
    const lot = { scope: 'lot', product_ref: null, fingerprint: null, lot_key: `walmart-line-${letters(64)}` };
    for (const bad of [{ answer: 'maybe' }, { answer: null }, { value_json: '{"vault":"home"}' }, { metal: 'XAU' }, lot,
      { kind: 'product-content', troy_oz_per_unit: '1/1' }, { scope: 'rule', product_ref: null, fingerprint: null, rule_id: 'spend-rule' }]) {
      expect(() => decide(bad), JSON.stringify(bad)).toThrow(failedCheck);
    }
    decide({});
    decide({ ...lot, evidence_digest: letters(64), answer: 'not-bullion' });
    expect(count(`SELECT count(*) FROM metals_owner_decisions WHERE kind = 'bullion'`)).toBe(2);

    // A void retires only its own account, only for a wrong account under that marker, and never as a collateral void.
    const voidFirst = (fields: Record<string, unknown>) => update('metals_imports', fields, 'import_id = ?', first.importId);
    expect(() => voidFirst({ ...voidFields(), retire_account_id: first.accountId })).toThrow(failedCheck);
    expect(() => voidFirst({ ...voidFields('wrong-account', 'import-wrong-payload'), retire_account_id: first.accountId })).toThrow(failedCheck);
    expect(() => voidFirst({ ...voidFields('wrong-account', 'import-wrong-account'), retire_account_id: first.accountId,
      voided_for_import: second.importId })).toThrow(failedCheck);
    expect(() => voidFirst({ ...voidFields(), voided_for_import: first.importId })).toThrow(failedCheck);
    voidFirst({ ...voidFields('wrong-account', 'import-wrong-account'), retire_account_id: first.accountId });
  });

  it('applies a stored lot-scope bullion answer only while the read\'s evidence digest is the one it pinned', () => {
    // The lead's confirmation: a lot-scope bullion decision pins the digest of that lot's flagged evidence, as a
    // product-content lot decision does; once the evidence differs, the line reads bullion-unconfirmed again.
    const flag: MetalsLineMetalUncertain = { guard: 'metal-guard-v1', evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU' };
    anImport(walmartPayload([syntheticOrder({
      source: 'walmart', channel: 'online', id: 'f2', date: '2030-01-10', skeleton: [metalItem(0, 200000)],
      components: [{ kind: 'tax', amountMinor: 0 }],
      admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000 },
      lines: [{ ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar Assay Card', productRef: 'walmart:100002', metal: null, metalUncertain: flag,
        form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [delivered(1, '2030-01-14')], seller: 'Sample Bullion Shop' }],
    })]), { label: 'Walmart account' });
    const order = JSON.parse(db.prepare(`SELECT canonical_json FROM metals_order_versions WHERE state = 'active'`).pluck().get() as string) as MetalsOrder;
    const lotKey = order.lines[0].key;
    expect(db.prepare('SELECT lot_key FROM metals_lots').pluck().get()).toBe(lotKey);
    const onLot = { scope: 'lot', product_ref: null, fingerprint: null, lot_key: lotKey, answer: 'not-bullion' };
    expect(() => insertLike('metals_owner_decisions', decision(onLot), { rowid: 1 })).toThrow(failedCheck);
    const pinned = letters(64);
    insertLike('metals_owner_decisions', decision({ ...onLot, evidence_digest: pinned }), { rowid: 1 });
    const stored = db.prepare(`SELECT lot_key AS lotKey, evidence_digest AS evidenceDigest, answer FROM metals_owner_decisions
      WHERE kind = 'bullion' AND scope = 'lot' AND revoked_at IS NULL`).get() as { lotKey: string; evidenceDigest: string; answer: MetalsBullionAnswer };
    const decisions: MetalsContentDecision[] = [{ kind: 'bullion', scope: 'lot', ...stored }];
    const read = (evidenceDigest: string) => metalsEffectiveSkeleton(order, 'walmart', { evidenceDigest, decisions, productRefUnique: () => true })
      .answers.map(({ answer, drift }) => ({ answer, drift }));
    expect(read(pinned)).toEqual([{ answer: 'not-bullion', drift: false }]);
    expect(read(letters(64))).toEqual([{ answer: null, drift: true }]);
  });

  it('writes explicit rowids, the version a progression replaced, the renewed count, and the newest import at a choice', () => {
    db.exec('CREATE TEMP TABLE seen (tbl TEXT NOT NULL, rid INTEGER)');
    for (const { table } of METALS_PROTECTED) {
      db.exec(`CREATE TEMP TRIGGER seen_${table} BEFORE INSERT ON ${table} BEGIN INSERT INTO seen VALUES ('${table}', NEW.rowid); END`);
    }
    const first = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })], { competitors: [competitor(77)], capturedAt: capturedOn(2) }),
      { label: 'Walmart account' });
    const account = { accountId: first.accountId! };
    const progressed = anImport(walmartPayload([walmartOrder(1)], { capture: 'c', capturedAt: capturedOn(4) }), account);
    expect(progressed.orders).toMatchObject({ progression: 1, renewed: 0 });
    expect(db.prepare('SELECT outcome, version, replaces_version AS replaces FROM metals_observations ORDER BY rowid').all()).toEqual([
      { outcome: 'new', version: 1, replaces: null }, { outcome: 'progression', version: 2, replaces: 1 }]);
    const conflict = anImport(walmartPayload([walmartOrder(1, { last4: '9999' })], { capture: 'd', capturedAt: capturedOn(5) }), account);
    expect(conflict.orders.conflict).toBe(1);
    expect(db.prepare('SELECT renewed_count FROM metals_imports ORDER BY import_seq').pluck().all()).toEqual([0, 0, 0]);
    supersedeMetalsVersions(db, { importId: conflict.importId!, orderKey: null, choose: 'incoming' },
      { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest: null });
    expect(db.prepare('SELECT version, chosen_seq AS chosenSeq FROM metals_order_versions WHERE chosen_by_go IS NOT NULL').all())
      .toEqual([{ version: 3, chosenSeq: 3 }]);
    // Each row the writers put into a protected table carried its rowid (one more than the table's highest), so NEW.rowid
    // was defined when its guards read it.
    const seenRows = db.prepare('SELECT tbl, rid FROM temp.seen ORDER BY rowid').all() as Array<{ tbl: string; rid: number }>;
    for (const { table } of METALS_PROTECTED) {
      expect(seenRows.filter(({ tbl }) => tbl === table).map(({ rid }) => rid), table)
        .toEqual(db.prepare(`SELECT rowid FROM ${table} ORDER BY rowid`).pluck().all());
    }
    expect(new Set(seenRows.map(({ tbl }) => tbl))).toEqual(new Set(['metals_accounts', 'metals_imports', 'metals_order_versions',
      'metals_observations', 'metals_competitor_observations']));
  });

  it('weighs a capture against the live observations of the active version and every version it copies (r6 §2.4)', () => {
    const shippedOnly = walmartOrder(1, { events: [shipped('2030-01-11')] });
    const first = anImport(walmartPayload([shippedOnly], { capturedAt: capturedOn(2) }), { label: 'Walmart account' });
    const account = { accountId: first.accountId! };
    const observed = anImport(walmartPayload([shippedOnly], { capture: 'c', capturedAt: capturedOn(6) }), account);
    const progressed = anImport(walmartPayload([walmartOrder(1)], { capture: 'd', capturedAt: capturedOn(8) }), account);
    expect(progressed.orders.progression).toBe(1);
    // What popping the progression leaves (corrections r6 §2.3): v2 voided, and v3, a copy of v1, active.
    const voidGo = letters(32);
    update('metals_imports', voidFields(), 'import_id = ?', progressed.importId);
    update('metals_order_versions', { state: 'superseded', resolution: 'voided', resolved_by_go: voidGo, resolved_at: NOW }, 'version = 2');
    insertLike('metals_order_versions', rowOf('metals_order_versions', 'version = 1'), { rowid: nextRowid('metals_order_versions'), version: 3,
      state: 'active', reason: 'reinstated', reinstates_version: 1, reinstated_by_go: voidGo, resolution: null, resolved_by_go: null, resolved_at: null });
    const outcome = (day: number) => planMetalsImport(db, {
      payload: walmartPayload([walmartOrder(1, { events: [] })], { capture: 'e', capturedAt: capturedOn(day) }), account }).orders;
    // v3 has no observation of its own: v1's live ones (days 2 and 6) weigh for it.
    expect(outcome(5)).toMatchObject({ predecessor: 1, conflict: 0 });
    expect(outcome(7)).toMatchObject({ predecessor: 0, conflict: 1 });
    // A voided import's observation weighs nothing.
    update('metals_imports', voidFields(), 'import_id = ?', observed.importId);
    expect(outcome(5)).toMatchObject({ predecessor: 0, conflict: 1 });
    expect(outcome(1)).toMatchObject({ predecessor: 1, conflict: 0 });
  });
});

describe('metals versions (§4.2)', () => {
  const canonical = (order: MetalsOrder) => canonicalMetalsOrder('walmart', order);
  const shippedOnly = canonical(walmartOrder(1, { events: [shipped('2030-01-11')] }));
  const deliveredToo = canonical(walmartOrder(1));

  it('treats a reordered capture of the same facts as the same version', () => {
    const reordered = canonical(walmartOrder(1, { events: [delivered(1, '2030-01-14'), shipped('2030-01-11')] }));
    expect(metalsOrderDigest(reordered)).toBe(metalsOrderDigest(deliveredToo));
    expect(classifyMetalsVersion(reordered, deliveredToo, false)).toBe('observation');
    expect(classifyMetalsVersion(reordered, deliveredToo, true)).toBe('observation');
    const twice = (first: 'stated' | 'year-inferred', second: 'stated' | 'year-inferred') => canonical(walmartOrder(2, { quantity: 2, events: [
      { kind: 'delivered', date: '2030-01-14', dateBasis: first, quantity: 1, occurrence: 1 },
      { kind: 'delivered', date: '2030-01-14', dateBasis: second, quantity: 1, occurrence: 2 },
    ] }));
    expect(metalsOrderDigest(twice('stated', 'year-inferred'))).toBe(metalsOrderDigest(twice('year-inferred', 'stated')));
  });

  it('progresses when events grow; a regression is a predecessor only from a provably older capture, else a conflict', () => {
    expect(classifyMetalsVersion(deliveredToo, shippedOnly, false)).toBe('progression');
    expect(classifyMetalsVersion(shippedOnly, deliveredToo, true)).toBe('predecessor');
    expect(classifyMetalsVersion(shippedOnly, deliveredToo, false)).toBe('conflict');
    const refunded = canonical(walmartOrder(1, { refunded: true }));
    expect(classifyMetalsVersion(refunded, deliveredToo, false)).toBe('progression');
    expect(classifyMetalsVersion(deliveredToo, refunded, true)).toBe('predecessor');
    expect(classifyMetalsVersion(deliveredToo, refunded, false)).toBe('conflict');
  });

  it('conflicts on a progression from a capture provably older than an observation of the active version', () => {
    expect(classifyMetalsVersion(deliveredToo, shippedOnly, true)).toBe('conflict');
    expect(classifyMetalsVersion(canonical(walmartOrder(1, { refunded: true })), deliveredToo, true)).toBe('conflict');
    expect(classifyMetalsVersion(canonical(walmartOrder(1, { massBasis: 'unknown' })), deliveredToo, true)).toBe('proposal');
  });

  it('proposes a policy change, even one that also progresses, and never applies it', () => {
    expect(classifyMetalsVersion(canonical(walmartOrder(1, { massBasis: 'unknown' })), deliveredToo, false)).toBe('proposal');
    expect(classifyMetalsVersion(canonical(walmartOrder(1, { massBasis: 'unknown' })), shippedOnly, false)).toBe('proposal');
  });

  it('conflicts on contradicted facts: a moved event, a changed date, another card', () => {
    for (const olderCapture of [false, true]) {
      expect(classifyMetalsVersion(canonical(walmartOrder(1, { events: [shipped('2030-01-11'), delivered(1, '2030-01-15')] })), deliveredToo, olderCapture))
        .toBe('conflict');
      expect(classifyMetalsVersion(canonical(walmartOrder(1, { date: '2030-01-09' })), deliveredToo, olderCapture)).toBe('conflict');
      expect(classifyMetalsVersion(canonical(walmartOrder(1, { last4: '9999' })), deliveredToo, olderCapture)).toBe('conflict');
    }
  });

  it('progresses a sale when its payout completes; back at agreed is a predecessor only from an older capture', () => {
    const pending = canonicalMetalsOrder('collectpure', collectpureSale(5, 'agreed'));
    const complete = canonicalMetalsOrder('collectpure', collectpureSale(5, 'complete'));
    expect(classifyMetalsVersion(complete, pending, false)).toBe('progression');
    expect(classifyMetalsVersion(pending, complete, true)).toBe('predecessor');
    expect(classifyMetalsVersion(pending, complete, false)).toBe('conflict');
  });
});

describe('metals import', () => {
  beforeEach(() => installMetalsSchema(db));

  it('imports new orders with their projections, competitors, holds and coverage; the same payload again writes nothing', () => {
    const payload = walmartPayload([walmartOrder(1)], { competitors: [competitor(77)] });
    const receipt = anImport(payload, { label: 'Walmart account' });
    expect(receipt).toMatchObject({ code: 'metals-imported', accountCreated: true, lines: 1, competitors: { new: 1, known: 0 }, held: 1, coverage: 1,
      orders: { new: 1, observation: 0, predecessor: 0, progression: 0, proposal: 0, conflict: 0 }, pending: [] });
    expect(receipt.importId).toMatch(/^mtl-imp-[a-p]{32}$/);
    expect(receipt.accountId).toMatch(/^mtl-acct-[a-p]{32}$/);
    expect(count('SELECT count(*) FROM metals_orders')).toBe(1);
    expect(count('SELECT count(*) FROM metals_lots')).toBe(1);
    expect(count('SELECT count(*) FROM metals_lot_events')).toBe(2);
    expect(count('SELECT count(*) FROM metals_tenders')).toBe(1);
    expect(count('SELECT count(*) FROM metals_card_evidence')).toBe(1);
    expect(count('SELECT count(*) FROM metals_competitors')).toBe(1);
    expect(count(`SELECT count(*) FROM metals_imports WHERE payload_sha256 NOT GLOB '*[^a-p]*'`)).toBe(1);
    const stored = JSON.parse(db.prepare('SELECT canonical_json FROM metals_order_versions').pluck().get() as string) as MetalsOrder;
    expect(metalsOrderDigest(stored)).toBe(db.prepare('SELECT digest FROM metals_order_versions').pluck().get());
    const again = importMetalsPayload(db, { payload, account: { label: 'Walmart account' } }, importCtx(payload));
    expect(again).toMatchObject({ code: 'metals-already-imported', importId: receipt.importId, accountId: receipt.accountId });
    expect(count('SELECT count(*) FROM metals_imports')).toBe(1);
  });

  it('numbers imports causally, inside their own write: 1, 2, 3 in commit order, never from a random id or a clock (G3-C1)', () => {
    const first = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const account = { accountId: first.accountId! };
    // A payload already imported takes no number.
    expect(anImport(walmartPayload([walmartOrder(1)]), account).code).toBe('metals-already-imported');
    const second = anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), account);
    const third = anImport(walmartPayload([walmartOrder(3)], { capture: 'd' }), account);
    expect(db.prepare('SELECT import_id AS importId, import_seq AS importSeq FROM metals_imports ORDER BY import_seq').all()).toEqual([
      { importId: first.importId, importSeq: 1 }, { importId: second.importId, importSeq: 2 }, { importId: third.importId, importSeq: 3 },
    ]);
    expect(() => db.prepare('UPDATE metals_imports SET import_seq = 9 WHERE import_seq = 3').run()).toThrow();
  });

  it('observes every competitor each import lists, an unchanged re-read included, and nothing for one it does not list (D-G2-2)', () => {
    const observed = (importId: string | null) => db.prepare(`SELECT order_key AS orderKey, fact_digest AS digest FROM metals_competitor_observations
      WHERE import_id = ? ORDER BY order_key`).all(importId);
    const factVersion = (orderKey: string, seq: number) => db.prepare('SELECT DISTINCT facts_digest FROM metals_competitors WHERE order_key = ? AND seq = ?')
      .pluck().get(orderKey, seq) as string;
    const [listed, other] = [competitor(77), competitor(78)];
    const first = anImport(walmartPayload([walmartOrder(1)], { competitors: [listed] }), { label: 'Walmart account' });
    const account = { accountId: first.accountId! };
    const original = factVersion(listed.orderKey, 1);
    expect(observed(first.importId)).toEqual([{ orderKey: listed.orderKey, digest: original }]);
    // The same payload again is already imported: it observes nothing more.
    expect(anImport(walmartPayload([walmartOrder(1)], { competitors: [listed] }), account).code).toBe('metals-already-imported');
    expect(count('SELECT count(*) FROM metals_competitor_observations')).toBe(1);
    // An unchanged re-read: no new fact-version, one more observation of the stored one.
    const reread = anImport(walmartPayload([walmartOrder(1)], { competitors: [listed], capture: 'c' }), account);
    expect(reread.competitors).toEqual({ new: 0, known: 1 });
    expect(observed(reread.importId)).toEqual([{ orderKey: listed.orderKey, digest: original }]);
    // An import that does not list it writes nothing for it.
    const elsewhere = anImport(walmartPayload([walmartOrder(1)], { competitors: [other], capture: 'd' }), account);
    expect(observed(elsewhere.importId)).toEqual([{ orderKey: other.orderKey, digest: factVersion(other.orderKey, 1) }]);
    // Changed facts follow the fact-version rule: a new fact-version, the old one kept (every one contests when read).
    const changed = anImport(walmartPayload([walmartOrder(1)], { competitors: [competitor(77, '3333')], capture: 'e' }), account);
    expect(changed.competitors).toEqual({ new: 1, known: 0 });
    const moved = factVersion(listed.orderKey, 2);
    expect(moved).not.toBe(original);
    expect(observed(changed.importId)).toEqual([{ orderKey: listed.orderKey, digest: moved }]);
    // The original facts seen again: known, observed under their own digest, no third fact-version.
    const back = anImport(walmartPayload([walmartOrder(1)], { competitors: [listed], capture: 'f' }), account);
    expect(back.competitors).toEqual({ new: 0, known: 1 });
    expect(observed(back.importId)).toEqual([{ orderKey: listed.orderKey, digest: original }]);
    expect(count('SELECT count(DISTINCT seq) FROM metals_competitors WHERE order_key = ?', listed.orderKey)).toBe(2);
    expect(count('SELECT count(*) FROM metals_competitor_observations WHERE order_key = ?', listed.orderKey)).toBe(4);
    expect(count('SELECT count(*) FROM metals_competitor_observations')).toBe(5);
    // Append-only, and every row names a stored fact-version.
    expect(() => db.prepare('UPDATE metals_competitor_observations SET fact_digest = ?').run(moved)).toThrow();
    expect(() => db.prepare('DELETE FROM metals_competitor_observations').run()).toThrow();
    expect(() => db.prepare('INSERT INTO metals_competitor_observations (import_id, order_key, fact_digest) VALUES (?, ?, ?)')
      .run(elsewhere.importId, listed.orderKey, 'a'.repeat(64))).toThrow(/stored fact-version/);
    expect(count('SELECT count(*) FROM metals_competitor_observations')).toBe(5);
  });

  it('keeps identical same-day events of one observation as two occurrences', () => {
    const order = walmartOrder(3, { quantity: 2, events: [delivered(1, '2030-01-14', 1), delivered(1, '2030-01-14', 2)] });
    anImport(walmartPayload([order]), { label: 'Walmart account' });
    expect(db.prepare('SELECT kind, event_date, quantity, occurrence FROM metals_lot_events ORDER BY seq').all()).toEqual([
      { kind: 'delivered', event_date: '2030-01-14', quantity: 1, occurrence: 1 },
      { kind: 'delivered', event_date: '2030-01-14', quantity: 1, occurrence: 2 },
    ]);
  });

  it('sees one order through two accounts as one inventory with two observations', () => {
    const first = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const second = anImport(walmartPayload([walmartOrder(1)], { folder: 'walmart-2' }), { label: 'Walmart account two' });
    expect(second.orders.observation).toBe(1);
    expect(second.accountId).not.toBe(first.accountId);
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(1);
    expect(count('SELECT count(*) FROM metals_orders')).toBe(1);
    expect(count('SELECT count(DISTINCT account_id) FROM metals_observations')).toBe(2);
  });

  it('progresses an order, treats an older capture as a predecessor, proposes a policy change and quarantines a conflict', () => {
    const created = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })], { capturedAt: capturedOn(2) }),
      { label: 'Walmart account' });
    const account = { accountId: created.accountId! };
    expect(anImport(walmartPayload([walmartOrder(1)], { capture: 'c', capturedAt: capturedOn(4) }), account).orders.progression).toBe(1);
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE state = 'superseded' AND resolution = 'progressed' AND resolved_by_go IS NULL`)).toBe(1);
    expect(count('SELECT count(*) FROM metals_lot_events')).toBe(2);
    expect(anImport(walmartPayload([walmartOrder(1, { events: [] })], { capture: 'd', capturedAt: capturedOn(3) }), account).orders.predecessor).toBe(1);
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(2);
    const proposal = anImport(walmartPayload([walmartOrder(1, { massBasis: 'unknown' })], { capture: 'e', capturedAt: capturedOn(5) }), account);
    expect(proposal.orders.proposal).toBe(1);
    expect(proposal.pending).toEqual([{ orderKey: walmartOrder(1).key, outcome: 'proposal' }]);
    expect(db.prepare('SELECT fine_basis FROM metals_lots').pluck().get()).toBe('stated-mass-basis');
    const conflict = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11'), delivered(1, '2030-01-15')] })],
      { capture: 'f', capturedAt: capturedOn(6) }), account);
    expect(conflict.orders.conflict).toBe(1);
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE state = 'conflict'`)).toBe(1);
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE state = 'active'`)).toBe(1);
    expect(db.prepare('SELECT event_date FROM metals_lot_events WHERE kind = ?').pluck().get('delivered')).toBe('2030-01-14');
    expect(count('SELECT count(*) FROM metals_observations')).toBe(5);

    // Root resolves the conflict for the incoming version and declines the proposal.
    const chooser = goId();
    const chosen = supersedeMetalsVersions(db, { importId: conflict.importId!, orderKey: null, choose: 'incoming' },
      { now: NOW, goId: chooser, purpose: 'copy-rehearsal', planDigest: null });
    expect(chosen).toMatchObject({ code: 'metals-superseded', orders: 1, before: { conflict: 1, quarantined: 1, lots: 1 },
      after: { conflict: 0, quarantined: 0, lots: 1 } });
    expect(db.prepare('SELECT event_date FROM metals_lot_events WHERE kind = ?').pluck().get('delivered')).toBe('2030-01-15');
    expect(db.prepare(`SELECT state, resolution, resolved_by_go, chosen_by_go FROM metals_order_versions WHERE version = 4`).get())
      .toEqual({ state: 'active', resolution: null, resolved_by_go: null, chosen_by_go: lettersOfHex(chooser) });
    expect(db.prepare(`SELECT state, resolution, resolved_by_go FROM metals_order_versions WHERE version = 2`).get())
      .toEqual({ state: 'superseded', resolution: 'replaced', resolved_by_go: lettersOfHex(chooser) });
    const decliner = goId();
    const declined = supersedeMetalsVersions(db, { importId: proposal.importId!, orderKey: walmartOrder(1).key, choose: 'active' },
      { now: NOW, goId: decliner, purpose: 'copy-rehearsal', planDigest: null });
    expect(declined).toMatchObject({ code: 'metals-superseded', after: { proposed: 0 } });
    expect(db.prepare(`SELECT state, resolution, resolved_by_go, chosen_by_go FROM metals_order_versions WHERE version = 3`).get())
      .toEqual({ state: 'superseded', resolution: 'declined', resolved_by_go: lettersOfHex(decliner), chosen_by_go: null });
    expect(supersedeMetalsVersions(db, { importId: proposal.importId!, orderKey: null, choose: 'active' },
      { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest: null }).code).toBe('metals-already-resolved');
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(4);
  });

  it('keeps the GO that chose a version through a later progression and a second supersede', () => {
    const [first, second] = [goId(), goId()];
    const created = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })], { capturedAt: capturedOn(1) }),
      { label: 'Walmart account' });
    const account = { accountId: created.accountId! };
    const moved = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-12')] })], { capture: 'c', capturedAt: capturedOn(2) }), account);
    expect(moved.orders.conflict).toBe(1);
    supersedeMetalsVersions(db, { importId: moved.importId!, orderKey: null, choose: 'incoming' },
      { now: NOW, goId: first, purpose: 'copy-rehearsal', planDigest: null });
    // A progression of the chosen version: it is superseded with no GO and keeps the one that chose it.
    const progressed = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-12'), delivered(1, '2030-01-14')] })],
      { capture: 'd', capturedAt: capturedOn(3) }), account);
    expect(progressed.orders.progression).toBe(1);
    const version = (n: number) => db.prepare(`SELECT state, resolution, resolved_by_go, chosen_by_go, chosen_at FROM metals_order_versions
      WHERE version = ?`).get(n);
    expect(version(2)).toEqual({ state: 'superseded', resolution: 'progressed', resolved_by_go: null, chosen_by_go: lettersOfHex(first), chosen_at: NOW });
    expect(version(3)).toMatchObject({ state: 'active', chosen_by_go: null });
    // Root chooses again, over the progressed version.
    const again = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-12'), delivered(1, '2030-01-15')] })],
      { capture: 'e', capturedAt: capturedOn(4) }), account);
    expect(again.orders.conflict).toBe(1);
    expect(supersedeMetalsVersions(db, { importId: again.importId!, orderKey: null, choose: 'incoming' },
      { now: NOW, goId: second, purpose: 'copy-rehearsal', planDigest: null }).code).toBe('metals-superseded');
    expect(version(2)).toMatchObject({ resolution: 'progressed', chosen_by_go: lettersOfHex(first) });
    expect(version(3)).toEqual({ state: 'superseded', resolution: 'replaced', resolved_by_go: lettersOfHex(second), chosen_by_go: null, chosen_at: null });
    expect(version(4)).toMatchObject({ state: 'active', resolution: null, chosen_by_go: lettersOfHex(second) });
    expect(db.prepare('SELECT event_date FROM metals_lot_events WHERE kind = ?').pluck().get('delivered')).toBe('2030-01-15');
    expect(() => db.prepare('UPDATE metals_order_versions SET chosen_by_go = ? WHERE version = 2').run('a'.repeat(32))).toThrow();
    expect(() => db.prepare('UPDATE metals_order_versions SET chosen_by_go = NULL, chosen_at = NULL WHERE version = 4').run()).toThrow();
  });

  it('weighs a regression by capture time: newer, equal or unknown is a conflict, provably older a predecessor', () => {
    const delivered14 = walmartOrder(1);
    const created = anImport(walmartPayload([delivered14], { capturedAt: capturedOn(10) }), { label: 'Walmart account' });
    const account = { accountId: created.accountId! };
    const shippedOnly = (capture: string, capturedAt: string) =>
      anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })], { capture, capturedAt }), account);
    expect(shippedOnly('c', capturedOn(9)).orders.predecessor).toBe(1);
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(1);
    const newer = shippedOnly('d', capturedOn(11));
    expect(newer.orders.conflict).toBe(1);
    expect(newer.pending).toEqual([{ orderKey: delivered14.key, outcome: 'conflict' }]);
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE state = 'conflict'`)).toBe(1);
    // The same regressed facts again: one more observation of the waiting conflict, never a second copy.
    expect(shippedOnly('e', capturedOn(12)).orders.observation).toBe(1);
    expect(count('SELECT count(*) FROM metals_order_versions')).toBe(2);
    // Root declines it; the regression seen once more is weighed again and raised again, never silently dropped.
    supersedeMetalsVersions(db, { importId: newer.importId!, orderKey: null, choose: 'active' }, { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest: null });
    const equal = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })], { capture: 'f', capturedAt: capturedOn(10) }), account);
    expect(equal.orders.conflict).toBe(1);
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE state = 'conflict' AND digest = (SELECT digest FROM metals_order_versions WHERE version = 2)`))
      .toBe(1);
    // A sale back at agreed: from a newer capture a conflict, from a provably older one a predecessor.
    const sale = anImport(syntheticPayload('collectpure', { orders: [collectpureSale(5, 'complete')] }), { label: 'CollectPure account' });
    const back = (capturedAt: string, capture: string) => {
      const payload = syntheticPayload('collectpure', { orders: [collectpureSale(5, 'agreed')] });
      if ('captureDigest' in payload.input) Object.assign(payload.input, { capturedAt, captureDigest: capture.repeat(64) });
      return anImport(payload, { accountId: sale.accountId! });
    };
    expect(back('2030-01-30T12:00:00Z', 'c').orders.predecessor).toBe(1);
    expect(back('2030-02-01T12:00:00Z', 'd').orders.conflict).toBe(1);
  });

  it('conflicts on a progression from a capture older than one that observed the active version, whatever the import order', () => {
    const created = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })], { capturedAt: capturedOn(10) }),
      { label: 'Walmart account' });
    const older = anImport(walmartPayload([walmartOrder(1)], { capture: 'c', capturedAt: capturedOn(9) }), { accountId: created.accountId! });
    expect(older.orders.conflict).toBe(1);
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE state = 'active' AND version = 1`)).toBe(1);
  });

  it('never treats a retail payload as an older capture: every Costco regression is a conflict', () => {
    const costco = (events: MetalsEvent[], retail: string) => {
      const payload = syntheticPayload('costco', { orders: [syntheticOrder({
        source: 'costco', channel: 'online', id: 'o1', date: '2030-02-03',
        skeleton: [metalItem(0, 420000, { shippingMinor: 0 })],
        admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 420000 }],
          refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 420000 },
        lines: [{ ordinal: 0, title: '1 oz Gold Bar Sample Refinery', productRef: 'costco:300003', metal: 'XAU', form: 'bar',
          statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: null, design: null, quantity: 1,
          unitPriceMinor: 420000, events }],
      })] });
      // Retail format 3 / policy 5, the input the contract reads for metals once P5 lands.
      if ('retailPayloadSha256' in payload.input) {
        Object.assign(payload.input, { retailPayloadSha256: retail.repeat(64), retailFormat: 3, retailPolicyVersion: 5 });
      }
      return payload;
    };
    const created = anImport(costco([shipped('2030-02-04'), delivered(1, '2030-02-07')], 'a'), { label: 'Costco account' });
    expect(anImport(costco([shipped('2030-02-04')], 'b'), { accountId: created.accountId! }).orders.conflict).toBe(1);
    expect(anImport(costco([shipped('2030-02-04'), delivered(1, '2030-02-07')], 'c'), { accountId: created.accountId! }).orders.observation).toBe(1);
    // The retail CHECKs are generated from the inputs the contract reads, so each is stored as read.
    expect(db.prepare('SELECT DISTINCT retail_format, retail_policy FROM metals_imports').raw().all()).toEqual([[3, 5]]);
    const ddl = METALS_SCHEMA_SQL.join('\n');
    expect(ddl).toContain(`retail_format IN (${METALS_RETAIL_FORMATS.join(', ')})`);
    expect(ddl).toContain(`retail_policy IN (${METALS_RETAIL_POLICIES.join(', ')})`);
  });

  it('writes nothing when the plan changed between the preflight and the write', () => {
    const created = anImport(walmartPayload([walmartOrder(1, { events: [shipped('2030-01-11')] })]), { label: 'Walmart account' });
    const account = { accountId: created.accountId! };
    const late = walmartPayload([walmartOrder(1, { massBasis: 'unknown', events: [shipped('2030-01-11')] })], { capture: 'c' });
    const plan = planMetalsImport(db, { payload: late, account });
    expect(plan.orders.proposal).toBe(1);
    anImport(walmartPayload([walmartOrder(1)], { capture: 'd' }), account);
    const imports = count('SELECT count(*) FROM metals_imports');
    let refusal: unknown;
    try {
      importMetalsPayload(db, { payload: late, account }, importCtx(late, plan.planDigest));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(MetalsRefusal);
    expect((refusal as MetalsRefusal).code).toBe('metals-plan-changed');
    expect(count('SELECT count(*) FROM metals_imports')).toBe(imports);
  });

  it('stores every payload the validator accepts at its boundaries: negative costs and nets, a null cap, a card refund, a long rational', () => {
    const barLine = (ordinal: number, amount: number, extra: Partial<SyntheticLineInput> = {}): SyntheticLineInput => ({
      ordinal, title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', productRef: 'walmart:100001', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'ozt' }, pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null,
      quantity: 1, unitPriceMinor: amount, events: [delivered(1, '2030-01-14')], seller: null, ...extra,
    });
    const card = (amountMinor: number) => ({ kind: 'card' as const, network: 'visa' as const, last4: '1111', amountMinor });
    const funding = (gross: number) => ({ fulfilment: { shipments: 1 }, methods: [card(gross)], refunded: false, cancelled: false,
      partlyCancelled: false, grossTotalMinor: gross });
    // A coupon larger than its metal item: a negative direct cost and cost.
    const coupon = syntheticOrder({
      source: 'walmart', channel: 'online', id: 40, date: '2030-01-10',
      skeleton: [metalItem(0, 1000), { ordinal: 1, kind: 'coupon', amountMinor: -1500, shippingMinor: null, feeParent: null, couponTarget: 0,
        taxFlag: null, metal: true }, otherItem(2, 5000)],
      admission: funding(4500),
      lines: [barLine(0, 1000)],
    });
    // Grams at five nines, marked gross: an exact fine content whose sides run past 12 digits.
    const long = syntheticOrder({
      source: 'walmart', channel: 'online', id: 41, date: '2030-01-10',
      skeleton: [metalItem(0, 900000)],
      admission: funding(900000),
      lines: [barLine(0, 900000, { title: 'Sample Refinery 1 g Gold Bar .99999', statedMass: { value: '99999.9999', unit: 'g' },
        purity: { text: '.99999', value: '99999/100000' }, massBasis: 'gross' })],
    });
    // Its title before contract follow-up 1E named a bar of gold and no weight: the pinned title rule refuses it
    // (shape-without-weight) and the guard flags it (adjacency), so 1E's validator check refuses the line stored
    // unflagged, and the importer, which validates every payload before anything is written, refuses the file.
    const unweighed = syntheticOrder({
      source: 'walmart', channel: 'online', id: 45, date: '2030-01-10',
      skeleton: [metalItem(0, 900000)],
      admission: funding(900000),
      lines: [barLine(0, 900000, { title: 'Sample Refinery Gold Bar .99999', statedMass: { value: '99999.9999', unit: 'g' },
        purity: { text: '.99999', value: '99999/100000' }, massBasis: 'gross' })],
    });
    expect(refusalOf(() => anImport(walmartPayload([unweighed]), { label: 'Walmart account' }))).toEqual({
      code: 'metals-payload-invalid',
      details: { issues: [{ path: '$.orders[0].lines[0].metalUncertain', message: 'is null, but the pinned title guard reads the stored title as metal-uncertain' }] },
    });
    const nullCap = syntheticCompetitor('walmart', 'online', 42, '2030-01-12', { fulfilment: { shipments: null },
      methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: null }], refunded: false, cancelled: false, partlyCancelled: false,
      grossTotalMinor: null });
    const refund = syntheticCompetitor('walmart', 'online', 43, '2030-01-12', { fulfilment: { shipments: 1 },
      methods: [card(3000), { kind: 'card-refund', network: 'visa', last4: '1111', amountMinor: -1000 }], refunded: true, cancelled: false,
      partlyCancelled: false, grossTotalMinor: 3000 });
    expect(anImport(walmartPayload([coupon, long], { competitors: [nullCap, refund] }), { label: 'Walmart account' }).orders.new).toBe(2);
    expect(db.prepare('SELECT amount_minor, direct_minor, cost_minor FROM metals_lots WHERE order_key = ?').get(coupon.key))
      .toEqual({ amount_minor: 1000, direct_minor: -500, cost_minor: -500 });
    expect(db.prepare('SELECT fine_troy_oz FROM metals_lots WHERE order_key = ?').pluck().get(long.key)).toMatch(/[0-9]{13}/);
    expect(db.prepare('SELECT basis, cap_minor FROM metals_competitors WHERE order_key = ?').get(nullCap.orderKey))
      .toEqual({ basis: 'aggregate', cap_minor: null });
    expect(db.prepare('SELECT kind, amount_minor FROM metals_competitors WHERE order_key = ? ORDER BY method').all(refund.orderKey))
      .toEqual([{ kind: 'card', amount_minor: 3000 }, { kind: 'card-refund', amount_minor: -1000 }]);

    // A sale line whose own fee is larger than it: a negative net on that line.
    const coin = (ordinal: number, amount: number): SyntheticLineInput => ({
      ordinal, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'collectpure:SKU-EAGLE', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1, unitPriceMinor: amount,
      events: [{ kind: 'agreed', date: '2030-02-01', dateBasis: 'stated', quantity: 1, occurrence: 1 }],
    });
    const sale = syntheticOrder({
      source: 'collectpure', channel: 'online', id: 44, date: '2030-02-01', status: 'agreed',
      skeleton: [metalItem(0, 1000), { ordinal: 1, kind: 'fee', amountMinor: -1500, shippingMinor: null, feeParent: 0, couponTarget: null,
        taxFlag: null, metal: true }, metalItem(2, 5000)],
      components: [{ kind: 'platform-fee', amountMinor: -100 }],
      lines: [coin(0, 1000), coin(2, 5000)],
    });
    anImport(syntheticPayload('collectpure', { orders: [sale] }), { label: 'CollectPure account' });
    expect(db.prepare('SELECT ordinal, gross_minor, net_minor, platform_fee_minor FROM metals_dispositions ORDER BY ordinal').all()).toEqual([
      { ordinal: 0, gross_minor: 1000, net_minor: -500, platform_fee_minor: 0 },
      { ordinal: 2, gross_minor: 5000, net_minor: 4900, platform_fee_minor: -100 },
    ]);
  });

  it('refuses, before any write, a line key another order already holds', () => {
    const first = walmartOrder(1);
    const created = anImport(walmartPayload([first]), { label: 'Walmart account' });
    const second = walmartOrder(2);
    second.lines[0] = { ...second.lines[0], key: first.lines[0].key };
    const imports = count('SELECT count(*) FROM metals_imports');
    let refusal: unknown;
    try {
      anImport(walmartPayload([second], { capture: 'c' }), { accountId: created.accountId! });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as MetalsRefusal).code).toBe('metals-key-conflict');
    expect((refusal as MetalsRefusal).details).toEqual({ orders: [second.key] });
    expect(count('SELECT count(*) FROM metals_imports')).toBe(imports);
  });

  it('refuses an account the payload does not belong to, and a second account for the same folder', () => {
    const created = anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const codeOf = (fn: () => unknown) => refusalOf(fn)?.code ?? null;
    expect(codeOf(() => anImport(walmartPayload([walmartOrder(2)], { folder: 'walmart-2' }), { accountId: created.accountId! })))
      .toBe('metals-account-mismatch');
    expect(codeOf(() => anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), { label: 'Another label' }))).toBe('metals-account-exists');
    expect(codeOf(() => anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), { accountId: `mtl-acct-${'a'.repeat(32)}` })))
      .toBe('metals-account-unknown');
    expect(codeOf(() => anImport(walmartPayload([walmartOrder(2)], { capture: 'c' }), { label: 'Card 1234' }))).toBe('metals-account-invalid');
    expect(codeOf(() => anImport({ ...walmartPayload([]), version: 2 } as unknown as MetalsImportPayload, { label: 'Walmart account' })))
      .toBe('metals-payload-invalid');
  });

  it('refuses, before any write, a run of 13 or more digits in any free text an order or a held record carries', () => {
    const LONG = '1234567890123';
    const withLine = (order: MetalsOrder, patch: Record<string, unknown>): MetalsOrder =>
      ({ ...order, lines: [{ ...order.lines[0], ...patch } as MetalsOrder['lines'][number]] });
    const sale = collectpureSale(5);
    const saleWith = (patch: Record<string, unknown>) => syntheticPayload('collectpure', { orders: [withLine(sale, { sale: { ...sale.lines[0].sale!, ...patch } })] });
    const cases: Array<[string, MetalsImportPayload]> = [
      ['$.orders[0].lines[0].title', walmartPayload([withLine(walmartOrder(1), { title: `Sample Gold Bar ${LONG}` })])],
      ['$.orders[0].lines[0].productRef', walmartPayload([withLine(walmartOrder(1), { productRef: `walmart:${LONG}` })])],
      ['$.orders[0].lines[0].seller', walmartPayload([withLine(walmartOrder(1), { seller: `Sample Shop ${LONG}` })])],
      ['$.orders[0].lines[0].sale.program', saleWith({ program: `Program ${LONG}` })],
      ['$.orders[0].lines[0].sale.premium.text', saleWith({ premium: { text: `${LONG} over spot`, basis: METALS_PREMIUM_BASES[0] } })],
      ['$.held[0].check', { ...walmartPayload([]), held: [{ key: syntheticKey('walmart', 'order', 'held-x'), channel: 'online', date: null,
        reason: 'field-unsupported', check: `x${LONG}` }] }],
    ];
    for (const [where, payload] of cases) {
      for (const attempt of [
        () => planMetalsImport(db, { payload, account: { label: 'Synthetic account' } }),
        () => importMetalsPayload(db, { payload, account: { label: 'Synthetic account' } }, { ...ctx(), inputSha256: 'a'.repeat(64) }),
      ]) {
        const refusal = refusalOf(attempt);
        expect(['metals-payload-invalid', 'metals-payload-free-text'], where).toContain(refusal?.code);
        const paths = refusal!.code === 'metals-payload-invalid'
          ? (refusal!.details.issues as Array<{ path: string }>).map((issue) => issue.path)
          : refusal!.details.paths as string[];
        expect(paths, where).toContain(where);
      }
    }
    // The validator admits a check code with a long digit run; the import's own guard refuses it.
    expect(refusalOf(() => planMetalsImport(db, { payload: cases[5][1], account: null }))).toEqual({ code: 'metals-payload-free-text',
      details: { paths: ['$.held[0].check'] } });
    for (const table of METALS_TABLES) expect(count(`SELECT count(*) FROM ${table}`), table).toBe(0);
    // A computed fine-content rational is exempt: its sides can be long.
    const order = canonicalMetalsOrder('walmart', walmartOrder(1));
    const long = { ...order, lines: [{ ...order.lines[0], fine: { ...order.lines[0].fine, troyOz: `${LONG}${LONG}/7` } }] } as MetalsOrder;
    expect(metalsFreeTextProblems({ orders: [long], held: [] })).toEqual([]);
    const nestedPaths = metalsFreeTextProblems({ orders: [withLine(order, { title: `Bar ${LONG}`, seller: `Shop ${LONG}`,
      sale: { program: `Program ${LONG}`, premium: { text: `${LONG}`, basis: 'per-oz' }, inspection: null } })], held: [] }).sort();
    expect(nestedPaths).toEqual(['$.orders[0].lines[0].sale.premium.text', '$.orders[0].lines[0].sale.program', '$.orders[0].lines[0].seller',
      '$.orders[0].lines[0].title']);
  });

  it('stores a flagged line and a product ref of the contract\'s whole length, as the validator accepts them (contract follow-up 1)', () => {
    // The contract admits both, and the schema stores both whole: no part is dropped, and nothing is refused for storage.
    const flag: MetalsLineMetalUncertain = { guard: 'metal-guard-v1', evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU' };
    const flagged = walmartPayload([syntheticOrder({
      source: 'walmart', channel: 'online', id: 'f1', date: '2030-01-10', skeleton: [metalItem(0, 200000)],
      components: [{ kind: 'tax', amountMinor: 0 }],
      admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000 },
      lines: [{ ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar Assay Card', productRef: 'walmart:100002', metal: null, metalUncertain: flag,
        form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [delivered(1, '2030-01-14')], seller: 'Sample Bullion Shop' }],
    })]);
    // Its canonical form keeps the contract's rule: a flagged order carries no card evidence, though its card method would
    // otherwise be admitted (canonicalMetalsPayload re-validates it, so a wrong form would be refused, not stored).
    expect(canonicalMetalsOrder('walmart', flagged.orders[0]).evidence).toEqual([]);
    const created = anImport(flagged, { label: 'Synthetic account' });
    expect(created.orders.new).toBe(1);
    expect(db.prepare(`SELECT metal, metal_uncertain_guard AS guard, metal_uncertain_evidence AS evidence, metal_uncertain_metal AS named
      FROM metals_lots`).get()).toEqual({ metal: null, guard: METALS_TITLE_GUARD, evidence: JSON.stringify(flag.evidence), named: 'XAU' });
    expect(count('SELECT count(*) FROM metals_card_evidence')).toBe(0);
    // The flag is a derived fact (versions.ts): the same source facts under another flag are a proposal, never a
    // progression or an observation.
    const stored = canonicalMetalsOrder('walmart', flagged.orders[0]);
    const evidence = ['troy-or-metric-weight'] as MetalsLineMetalUncertain['evidence'];
    const reflagged: MetalsOrder = { ...stored, lines: [{ ...stored.lines[0], metalUncertain: { ...flag, evidence } }] };
    expect(classifyMetalsVersion(reflagged, stored, false)).toBe('proposal');
    // The database keeps the validator's flag rules: the evidence in its closed order, once each, and a flag only on a
    // line that names no metal.
    expect(METALS_GUARD_EVIDENCE_LISTS).toHaveLength(2 ** METALS_GUARD_EVIDENCE.length - 1);
    const flaggedLot = db.prepare('SELECT lot_key FROM metals_lots').pluck().get() as string;
    expect(() => db.prepare('UPDATE metals_lots SET metal_uncertain_evidence = ? WHERE lot_key = ?')
      .run(JSON.stringify([...flag.evidence].reverse()), flaggedLot)).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare("UPDATE metals_lots SET metal = 'XAU' WHERE lot_key = ?").run(flaggedLot)).toThrow(/CHECK constraint failed/);
    // A product ref keeps the validator's whole id, up to METALS_PRODUCT_REF_MAX characters after its source: stored and
    // read back at the cap; one more is the validator's refusal; and in direct SQL the CHECK admits the cap and refuses
    // one more, a run of 13 digits, a character outside the id's set and an empty id.
    const withRef = (id: string) => {
      const order = walmartOrder(2);
      return walmartPayload([{ ...order, lines: [{ ...order.lines[0], productRef: `walmart:${id}` }] }], { capture: 'c' });
    };
    anImport(withRef('a'.repeat(METALS_PRODUCT_REF_MAX)), { accountId: created.accountId! });
    const capped = db.prepare('SELECT lot_key FROM metals_lots WHERE product_ref = ?').pluck()
      .get(`walmart:${'a'.repeat(METALS_PRODUCT_REF_MAX)}`) as string | undefined;
    expect(capped).toBeDefined();
    expect(refusalOf(() => planMetalsImport(db, { payload: withRef('a'.repeat(METALS_PRODUCT_REF_MAX + 1)), account: null })))
      .toMatchObject({ code: 'metals-payload-invalid', details: { issues: [{ path: '$.orders[0].lines[0].productRef' }] } });
    const setRef = db.prepare('UPDATE metals_lots SET product_ref = ? WHERE lot_key = ?');
    expect(setRef.run(`walmart:${'b'.repeat(METALS_PRODUCT_REF_MAX)}`, capped).changes).toBe(1);
    for (const ref of [`walmart:${'b'.repeat(METALS_PRODUCT_REF_MAX + 1)}`, `walmart:a${'7'.repeat(13)}`, 'walmart:a b', 'walmart:']) {
      expect(() => setRef.run(ref, capped), ref).toThrow(/CHECK constraint failed/);
    }
  });

  it('stores every rule a payload pins, one import column per METALS_RULES key, so no rule is dropped (1E-ready)', () => {
    anImport(walmartPayload([walmartOrder(1)]), { label: 'Walmart account' });
    const columns = db.prepare(`SELECT name FROM pragma_table_info('metals_imports') WHERE name GLOB '*_rule'`).pluck().all() as string[];
    expect(columns).toEqual(Object.keys(METALS_RULES).map((key) => `${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_rule`));
    expect(db.prepare(`SELECT ${columns.join(', ')} FROM metals_imports`).raw().get()).toEqual(Object.values(METALS_RULES));
  });

  it('imports only the payload its GO names', () => {
    const payload = walmartPayload([walmartOrder(1)]);
    const other = walmartPayload([walmartOrder(2)], { capture: 'c' });
    expect(refusalOf(() => importMetalsPayload(db, { payload, account: { label: 'Walmart account' } }, { ...ctx(), inputSha256: metalsPayloadSha256(other) })))
      .toEqual({ code: 'metals-input-mismatch', details: {} });
    expect(refusalOf(() => importMetalsPayload(db, { payload, account: { label: 'Walmart account' } }, { ...ctx(), inputSha256: 'A'.repeat(64) })))
      .toEqual({ code: 'metals-input-sha-invalid', details: {} });
    expect(count('SELECT count(*) FROM metals_imports')).toBe(0);
    expect(anImport(payload, { label: 'Walmart account' }).code).toBe('metals-imported');
  });

  it('refuses a supersede of an unknown import, an order it left nothing pending for, a malformed request or a clashing key', () => {
    const created = anImport(walmartPayload([walmartOrder(1), walmartOrder(2)], { capturedAt: capturedOn(1) }), { label: 'Walmart account' });
    const account = { accountId: created.accountId! };
    // Order 1's capture moves a line onto order 2's lot key: a conflict, stored and quarantined, that can never be chosen.
    const moved = walmartOrder(1, { events: [shipped('2030-01-11'), delivered(1, '2030-01-15')] });
    moved.lines[0] = { ...moved.lines[0], key: walmartOrder(2).lines[0].key };
    const conflict = anImport(walmartPayload([moved], { capture: 'c', capturedAt: capturedOn(2) }), account);
    expect(conflict.orders.conflict).toBe(1);
    const supersede = (request: Record<string, unknown>, planDigest: string | null = null) => refusalOf(() => supersedeMetalsVersions(db,
      { importId: conflict.importId!, orderKey: null, choose: 'incoming', ...request } as never,
      { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest }));
    expect(supersede({ importId: `mtl-imp-${'a'.repeat(32)}` })?.code).toBe('metals-import-unknown');
    expect(supersede({ orderKey: walmartOrder(2).key })?.code).toBe('metals-order-not-pending');
    expect(supersede({ importId: created.importId!, orderKey: walmartOrder(1).key })?.code).toBe('metals-order-not-pending');
    for (const bad of [{ choose: 'both' }, { importId: 'mtl-imp-1' }, { orderKey: 'walmart-order-1' }]) {
      expect(supersede(bad)?.code).toBe('metals-supersede-invalid');
    }
    expect(supersede({})).toEqual({ code: 'metals-key-conflict', details: { orders: [moved.key] } });
    expect(refusalOf(() => planMetalsSupersede(db, { importId: conflict.importId!, orderKey: null, choose: 'incoming' })))
      .toEqual({ code: 'metals-key-conflict', details: { orders: [moved.key] } });
    // Declining it is always possible; a plan made before another write changed it refuses.
    const plan = planMetalsSupersede(db, { importId: conflict.importId!, orderKey: null, choose: 'active' });
    supersedeMetalsVersions(db, { importId: conflict.importId!, orderKey: moved.key, choose: 'active' },
      { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest: null });
    expect(supersede({ choose: 'active' }, plan.planDigest)?.code).toBe('metals-plan-changed');
    expect(count(`SELECT count(*) FROM metals_order_versions WHERE resolution = 'declined'`)).toBe(1);
  });
});

describe('metals bindings', () => {
  const checkingId = `chk-acct-${'b'.repeat(32)}`;
  beforeEach(() => {
    installMetalsSchema(db);
    installCheckingSchema(db);
    db.prepare(`INSERT INTO checking_accounts (id, institution, account_type, last4, label, currency, status, created_at)
      VALUES (?, 'testbank', 'checking', '2222', 'Synthetic Checking', 'USD', 'active', ?)`).run(checkingId, NOW);
    anImport(walmartPayload([walmartOrder(1)], { competitors: [competitor(77, '3333')] }), { label: 'Walmart account' });
    anImport(syntheticPayload('collectpure', { orders: [collectpureSale(5)] }), { label: 'CollectPure account' });
  });

  const approvalOf = (pairs: MetalsBindingPair[]) => {
    const { proposal } = proposeMetalsBindings(db, DATABASE_REF);
    return { proposal, approval: { proposalSha256: sha256Hex(serializeMetalsBindingProposal(proposal)), inventoryDigest: proposal.inventoryDigest, pairs } };
  };
  const bindingCtx = () => ({ now: NOW, goId: goId(), purpose: 'copy-rehearsal' as const, planDigest: null, databaseRef: DATABASE_REF });

  it('proposes every identity with its candidate accounts, and approves exactly the named pairs', () => {
    const { proposal, summary } = proposeMetalsBindings(db, DATABASE_REF);
    expect(summary).toEqual({ identities: 3, card: 2, checking: 1, withoutCandidates: 1, oneCandidate: 2, severalCandidates: 0, bound: 0, unidentified: 0 });
    const card = db.prepare('SELECT id FROM card_accounts').pluck().get() as string;
    expect(proposal.identities.find((identity) => identity.last4 === '1111')?.candidates).toEqual([{ accountId: card, status: 'active', issuer: 'testbank' }]);
    const pairs: MetalsBindingPair[] = [
      { kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: card },
      { kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: checkingId },
    ];
    const { approval } = approvalOf(pairs);
    expect(approveMetalsBindings(db, proposal, approval, bindingCtx())).toMatchObject({ code: 'metals-bindings-approved', activated: 2, card: 1, checking: 1 });
    expect(db.prepare('SELECT kind, account_status, account_owner, peer_account_ids FROM metals_bindings ORDER BY kind').all()).toEqual([
      { kind: 'card', account_status: 'active', account_owner: 'alex', peer_account_ids: JSON.stringify([card]) },
      { kind: 'checking', account_status: 'active', account_owner: null, peer_account_ids: JSON.stringify([checkingId]) },
    ]);
    expect(approveMetalsBindings(db, proposal, approval, bindingCtx()).code).toBe('metals-bindings-already-active');
    const ids = db.prepare('SELECT binding_id FROM metals_bindings ORDER BY kind').pluck().all() as string[];
    expect(revokeMetalsBindings(db, [ids[0]], { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest: null }))
      .toMatchObject({ code: 'metals-bindings-revoked', revoked: 1 });
    expect(revokeMetalsBindings(db, [ids[0]], { now: NOW, goId: goId(), purpose: 'copy-rehearsal', planDigest: null }).code)
      .toBe('metals-bindings-already-revoked');
    expect(count(`SELECT count(*) FROM metals_bindings WHERE state = 'active'`)).toBe(1);
  });

  it('refuses an approval once any account changed since the proposal, and a pair the proposal does not offer', () => {
    const card = db.prepare('SELECT id FROM card_accounts').pluck().get() as string;
    const { proposal, approval } = approvalOf([{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: card }]);
    const wrong = { ...approval, pairs: [{ kind: 'card' as const, source: 'walmart' as const, network: 'visa' as const, last4: '3333', accountId: card }] };
    expect(() => approveMetalsBindings(db, proposal, wrong, bindingCtx())).toThrow(/metals-pairs-invalid/);
    db.close();
    const repo = new SqliteStateRepo({ file });
    repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '1111', currency: 'USD' });
    repo.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    expect(() => approveMetalsBindings(db, proposal, approval, bindingCtx())).toThrow(/metals-inventory-changed/);
    expect(count('SELECT count(*) FROM metals_bindings')).toBe(0);
    expect(proposeMetalsBindings(db, DATABASE_REF).summary.severalCandidates).toBe(1);
  });

  it('binds a closed account only when an approval names it, and refuses another account for a bound identity', () => {
    db.close();
    const repo = new SqliteStateRepo({ file });
    const closed = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '3333', currency: 'USD', status: 'closed' }).id;
    const second = repo.createCardAccount({ issuer: 'thirdbank', owner: 'alex', last4: '1111', currency: 'USD' }).id;
    repo.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    const first = db.prepare(`SELECT id FROM card_accounts WHERE issuer = 'testbank'`).pluck().get() as string;
    const visa = (last4: string, accountId: string): MetalsBindingPair => ({ kind: 'card', source: 'walmart', network: 'visa', last4, accountId });
    const offered = approvalOf([visa('1111', first)]);
    expect(offered.proposal.identities.find((identity) => identity.last4 === '3333')?.candidates)
      .toEqual([{ accountId: closed, status: 'closed', issuer: 'otherbank' }]);
    expect(approveMetalsBindings(db, offered.proposal, offered.approval, bindingCtx())).toMatchObject({ activated: 1, closedAccounts: 0 });
    expect(count('SELECT count(*) FROM metals_bindings WHERE account_id = ?', closed)).toBe(0);
    expect(db.prepare('SELECT peer_account_ids FROM metals_bindings WHERE account_id = ?').pluck().get(first)).toBe(JSON.stringify([first, second].sort()));
    const named = approvalOf([visa('3333', closed)]);
    expect(approveMetalsBindings(db, named.proposal, named.approval, bindingCtx())).toMatchObject({ activated: 1, closedAccounts: 1 });
    expect(db.prepare('SELECT state, account_status, account_owner, peer_account_ids FROM metals_bindings WHERE account_id = ?').get(closed))
      .toEqual({ state: 'active', account_status: 'closed', account_owner: 'casey', peer_account_ids: JSON.stringify([closed]) });
    const rebind = approvalOf([visa('1111', second)]);
    expect(refusalOf(() => approveMetalsBindings(db, rebind.proposal, rebind.approval, bindingCtx()))?.code).toBe('metals-binding-conflict');
    expect(count(`SELECT count(*) FROM metals_bindings WHERE state = 'active'`)).toBe(2);
  });

  it('refuses a proposal or approval that does not match, an unknown binding, and a plan another write changed', () => {
    const card = db.prepare('SELECT id FROM card_accounts').pluck().get() as string;
    const { proposal, approval } = approvalOf([{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: card }]);
    const codeOf = (fn: () => unknown) => refusalOf(fn)?.code ?? null;
    expect(codeOf(() => approveMetalsBindings(db, proposal, { ...approval, proposalSha256: 'f'.repeat(64) }, bindingCtx()))).toBe('metals-proposal-mismatch');
    expect(codeOf(() => approveMetalsBindings(db, proposal, { ...approval, inventoryDigest: 'f'.repeat(64) }, bindingCtx()))).toBe('metals-proposal-mismatch');
    expect(codeOf(() => approveMetalsBindings(db, proposal, approval, { ...bindingCtx(), databaseRef: 'd'.repeat(64) }))).toBe('metals-proposal-mismatch');
    expect(codeOf(() => approveMetalsBindings(db, { ...proposal, version: 2 } as never, approval, bindingCtx()))).toBe('metals-proposal-invalid');
    expect(codeOf(() => validMetalsBindingProposal({ ...proposal, extra: 1 }))).toBe('metals-proposal-invalid');
    expect(codeOf(() => revokeMetalsBindings(db, [`mtl-bind-${'a'.repeat(32)}`], ctx()))).toBe('metals-binding-unknown');
    expect(count('SELECT count(*) FROM metals_bindings')).toBe(0);
    const plan = planMetalsBindingApproval(db, proposal, approval, DATABASE_REF);
    approveMetalsBindings(db, proposal, approval, bindingCtx());
    expect(codeOf(() => approveMetalsBindings(db, proposal, approval, { ...bindingCtx(), planDigest: plan.planDigest }))).toBe('metals-plan-changed');
    const ids = db.prepare('SELECT binding_id FROM metals_bindings').pluck().all() as string[];
    const revocation = planMetalsBindingRevocation(db, ids);
    revokeMetalsBindings(db, ids, ctx());
    expect(codeOf(() => revokeMetalsBindings(db, ids, ctx(revocation.planDigest)))).toBe('metals-plan-changed');
    expect(db.prepare('SELECT state FROM metals_bindings').pluck().all()).toEqual(['revoked']);
  });
});

describe('metals report', () => {
  it('counts and dates only, under a strict schema', () => {
    expect(metalsReport(db)).toMatchObject({ code: 'metals-report', schema: 'absent', accounts: 0, newestImport: null, orderDates: null });
    installMetalsSchema(db);
    anImport(walmartPayload([walmartOrder(1)], { competitors: [competitor(77)] }), { label: 'Walmart account' });
    const report = metalsReport(db);
    expect(report).toEqual({
      code: 'metals-report', schema: 'present', accounts: 1, imports: 1, orders: { buy: 1, sell: 0 }, lots: 1, dispositions: 0,
      versions: { active: 1, superseded: 0, proposed: 0, conflict: 0 }, quarantined: 0, competitors: 1, holds: 1, coverage: 1,
      bindings: { active: 0, revoked: 0 }, decisions: { live: 0, revoked: 0 }, newestImport: '2030-03-01', orderDates: { from: '2030-01-10', to: '2030-01-10' },
    });
    const line = formatMetalsReport(report)!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line).not.toMatch(/200000|1111|Walmart account|walmart-/);
    const bad: Array<Partial<MetalsReport> & Record<string, unknown>> = [
      { ...report, lots: 123456789 }, { ...report, extra: 1 }, { ...report, newestImport: '20300301' },
      { ...report, orders: { buy: 1, sell: 0, other: 2 } as never }, { ...report, orderDates: { from: '2030-01-10' } as never },
    ];
    for (const item of bad) expect(formatMetalsReport(item as MetalsReport)).toBeNull();
  });
});
describe('metals fenced write (ROOT rollback rule)', () => {
  it('holds the write lock from before its backup until its commit: no other connection commits a write in between', async () => {
    db.exec('CREATE TABLE fence_probe (id INTEGER PRIMARY KEY)');
    const other = new Database(file, { timeout: 0 });
    try {
      const attempt = () => {
        try {
          other.prepare('INSERT INTO fence_probe DEFAULT VALUES').run();
          return 'committed';
        } catch (error) {
          if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY')) return 'busy';
          throw error;
        }
      };
      const seen: Array<[string, string]> = [];
      const backup = path.join(dir, 'fenced-backup.db');
      // The state the fence begins from, table by table: the card account and the empty probe table among them.
      const before = tablesAndCounts(db);
      expect(before).toContainEqual(['card_accounts', 1]);
      expect(before).toContainEqual(['fence_probe', 0]);
      const result = await fencedMetalsWrite(db, backup, () => 'written', installMetalsSchema, (point) => { seen.push([point, attempt()]); });
      expect(seen).toEqual([['fenced', 'busy'], ['backed-up', 'busy'], ['written', 'busy']]);
      expect(result).toBe('written');
      expect(metalsSchemaState(db)).toBe('present');
      // The other writer waited out the fence, not lost: it commits once the metals write has.
      expect(attempt()).toBe('committed');
      // The backup is the state the fence began from: no metals table and no write of the other connection.
      const copy = new Database(backup, { readonly: true, fileMustExist: true });
      try {
        expect(metalsSchemaState(copy)).toBe('absent');
        expect(copy.prepare('SELECT count(*) FROM fence_probe').pluck().get()).toBe(0);
        // Every table with its row count, as the fence found them. An empty file would pass the schema check and
        // integrity_check, and fail the count above only by an error.
        expect(tablesAndCounts(copy)).toEqual(before);
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        copy.close();
      }
    } finally {
      other.close();
    }
  });

  it('rolls a failed write back inside its fence, keeps the backup and restores nothing', async () => {
    const backup = path.join(dir, 'fenced-failed.db');
    await expect(fencedMetalsWrite(db, backup, () => { throw new Error('synthetic failure'); }, installMetalsSchema)).rejects.toThrow();
    expect(db.inTransaction).toBe(false);
    expect(metalsSchemaState(db)).toBe('absent');
    expect(fs.existsSync(backup)).toBe(true);
    // A backup path that is the database itself, or relative, is refused before the fence begins.
    await expect(fencedMetalsWrite(db, file, () => 'never', installMetalsSchema)).rejects.toThrow('metals backup refused');
    await expect(fencedMetalsWrite(db, 'relative.db', () => 'never', installMetalsSchema)).rejects.toThrow('metals backup refused');
    expect(db.inTransaction).toBe(false);
  });
});
