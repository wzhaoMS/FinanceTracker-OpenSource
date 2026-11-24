import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { digest } from '../services/amazon/policy.js';
import {
  CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST,
  CARD_PAYMENT_DECISIONS_SCHEMA_SQL,
  cardPaymentDecisionsSchemaState,
} from '../services/cardPaymentDecisions.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { PAYMENT_RECONCILIATION_CLI_USAGE, runPaymentReconciliationCli } from './paymentReconciliation.js';

// Synthetic only: an empty database made by this build, made-up GO ids and a synthetic probe row.
let template: string, dir: string, file: string, stdout: string, stderr: string;
const REFUSED = 'payment-reconciliation: input-refused HoldrRefusal\n';
const run = (args: string[]) => runPaymentReconciliationCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => new Date('2026-10-21T00:00:00Z'),
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const write = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return p;
};
const goFields = (patch: Record<string, unknown> = {}) => ({
  format: 'holdr.payment-reconciliation-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal',
  command: 'install', goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)),
  schemaDigest: CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST, ...patch,
});
const go = (patch: Record<string, unknown> = {}) => write(`go-${randomBytes(6).toString('hex')}.json`, goFields(patch));
const goIdOf = (goFile: string) => JSON.parse(fs.readFileSync(goFile, 'utf8')).goId as string;
const install = (goFile: string, backup: string) => run(['install', '--db', file, '--backup', path.join(dir, backup), '--root-go', goFile]);
const plan = async () => {
  stdout = '';
  const code = await run(['plan', '--db', file]);
  const answer = JSON.parse(stdout);
  stdout = '';
  return { code, answer };
};
const planned = (schema: string, code = 'payment-reconciliation-planned') => ({ code, schema,
  schemaDigest: CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
const opened = <T>(fn: (db: Database.Database) => T, target = file) => {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
};
const alter = (sql: string) => {
  const db = new Database(file);
  try { db.exec(sql); } finally { db.close(); }
};
const objects = (db: Database.Database) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as
  Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
const rowCounts = (db: Database.Database) => Object.fromEntries(objects(db)
  .filter((object) => object.type === 'table' && !object.name.startsWith('sqlite_'))
  .map((object) => [object.name, db.prepare(`SELECT count(*) FROM "${object.name}"`).pluck().get()]));

beforeAll(async () => {
  template = await makeScratchDir('payment-reconciliation-template-');
  const templateFile = path.join(template, 'finance.db');
  new SqliteStateRepo({ file: templateFile }).close();
  const db = new Database(templateFile);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('payment-reconciliation-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(dir); });

describe('card payment reconciliation operator CLI', () => {
  it('prints its usage, and plans read-only with codes and digests only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(PAYMENT_RECONCILIATION_CLI_USAGE);
    stdout = '';
    const before = fs.readFileSync(file);
    expect(await plan()).toEqual({ code: 0, answer: planned('absent') });
    expect(fs.readFileSync(file)).toEqual(before);
    for (const args of [[], ['plan'], ['plan', '--db', 'finance.db'], ['plan', '--db', file, '--db', file],
      ['migrate', '--db', file], ['install', '--db', file]]) {
      expect(await run(args)).toBe(1);
    }
    expect(stderr).toBe(REFUSED.repeat(6));
    expect(stdout).toBe('');
  });

  it('reports anything else of those names or on that table as a conflict, and refuses to install over it before any backup', async () => {
    const [table, ...indexes] = CARD_PAYMENT_DECISIONS_SCHEMA_SQL;
    for (const sql of [
      'CREATE TABLE card_payment_decisions (id TEXT PRIMARY KEY)',
      'CREATE VIEW card_payment_decisions AS SELECT 1 AS synthetic',
      `${table}; ${indexes.slice(1).join('; ')}`,
      `${table}; ${indexes.join('; ')}; CREATE INDEX synthetic_extra ON card_payment_decisions (currency)`,
      `${table.replace('TABLE card_payment_decisions', 'TABLE CARD_PAYMENT_DECISIONS')}`,
    ]) {
      alter(sql);
      const before = opened(objects);
      expect(await plan(), sql).toEqual({ code: 1, answer: planned('conflict', 'payment-reconciliation-conflict') });
      stderr = '';
      expect(await install(go(), 'never.db')).toBe(1);
      expect(stderr).toBe(REFUSED);
      expect(fs.existsSync(path.join(dir, 'never.db'))).toBe(false);
      expect(opened(objects)).toEqual(before);
      const kind = opened((db) => db.prepare("SELECT type FROM sqlite_master WHERE name = 'card_payment_decisions' COLLATE NOCASE").pluck().get());
      alter(`DROP ${kind === 'view' ? 'VIEW' : 'TABLE'} card_payment_decisions`);
    }
  });

  it('refuses every unauthorized install before any backup or write', async () => {
    const backup = path.join(dir, 'never.db');
    const args = (goFile: string) => ['install', '--db', file, '--backup', backup, '--root-go', goFile];
    const before = opened(objects);
    const variants: Array<[string, string[]]> = [
      ['no GO', ['install', '--db', file, '--backup', backup]],
      ['relative GO path', args(path.basename(go()))],
      ['relative backup', ['install', '--db', file, '--backup', 'never.db', '--root-go', go()]],
      ['missing GO', args(path.join(dir, 'no-go.json'))],
      ['GO is not JSON', args(write('not-json.json', '{"format":'))],
      ...([
        ['the spending rules GO', { format: 'holdr.spending-rules-go' }], ['version', { version: 2 }],
        ['authority', { authority: 'Mac' }], ['decision', { decision: 'NO-GO' }], ['purpose', { purpose: 'production-import' }],
        ['command', { command: 'plan' }], ['malformed goId', { goId: 'not-a-nonce' }],
        ['another database', { databaseRef: digest(path.resolve(dir, 'other.db')) }],
        ['another schema', { schemaDigest: digest('synthetic other schema') }], ['extra field', { maxRows: 1 }],
      ] as Array<[string, Record<string, unknown>]>).map(([name, patch]): [string, string[]] => [name, args(go(patch))]),
    ];
    for (const [name, variant] of variants) {
      stderr = '';
      expect(await run(variant), name).toBe(1);
      expect(stderr, name).toBe(REFUSED);
    }
    stderr = '';
    fs.writeFileSync(path.join(dir, 'taken.db'), '');
    expect(await install(go(), 'taken.db')).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'taken.db'), 'utf8')).toBe('');
    expect(stderr).toBe(REFUSED);
    expect(fs.existsSync(backup)).toBe(false);
    expect(opened(cardPaymentDecisionsSchemaState)).toBe('absent');
    expect(opened(objects)).toEqual(before);
    expect(stdout).toBe('');
  });

  it('installs once, after a complete pre-install backup, then reports already installed without a backup', async () => {
    const before = opened(objects);
    const counts = opened(rowCounts);
    const first = go();
    expect(await install(first, 'before-decisions.db')).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ code: 'payment-reconciliation-installed', purpose: 'copy-rehearsal', goId: goIdOf(first),
      schemaDigest: CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(stdout).not.toContain(dir);

    const backup = path.join(dir, 'before-decisions.db');
    expect(opened((db) => db.pragma('integrity_check', { simple: true }), backup)).toBe('ok');
    expect(opened(cardPaymentDecisionsSchemaState, backup)).toBe('absent');
    expect(opened(objects, backup)).toEqual(before);

    // The table, its primary key's index and the three unique indexes; nothing else, and no row anywhere.
    expect(opened(cardPaymentDecisionsSchemaState)).toBe('present');
    const old = new Set(before.map((object) => object.name));
    const after = opened(objects);
    expect(after.filter((object) => old.has(object.name))).toEqual(before);
    expect(after.filter((object) => !old.has(object.name)).map((object) => [object.type, object.name, object.tbl_name])).toEqual([
      ['index', 'card_payment_decisions_debit', 'card_payment_decisions'],
      ['index', 'card_payment_decisions_payment', 'card_payment_decisions'],
      ['index', 'card_payment_decisions_rejected', 'card_payment_decisions'],
      ['index', 'sqlite_autoindex_card_payment_decisions_1', 'card_payment_decisions'],
      ['table', 'card_payment_decisions', 'card_payment_decisions'],
    ]);
    expect(opened(rowCounts)).toEqual({ ...counts, card_payment_decisions: 0 });

    const version = opened((db) => db.pragma('schema_version', { simple: true }));
    const second = go({ purpose: 'production-install' });
    stdout = '';
    expect(await install(second, 'again.db')).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'payment-reconciliation-already-installed', purpose: 'production-install',
      goId: goIdOf(second), schemaDigest: CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(fs.existsSync(path.join(dir, 'again.db'))).toBe(false);
    expect(opened((db) => db.pragma('schema_version', { simple: true }))).toBe(version);
    expect(await plan()).toEqual({ code: 0, answer: planned('present') });
  });
});
