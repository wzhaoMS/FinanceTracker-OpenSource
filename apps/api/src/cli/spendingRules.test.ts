import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { digest } from '../services/amazon/policy.js';
import { CARD_SPENDING_RULES_SCHEMA_DIGEST, CARD_SPENDING_RULES_SCHEMA_SQL, cardSpendingRulesSchemaState } from '../services/cardSpendingRules.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { SPENDING_RULES_CLI_USAGE, runSpendingRulesCli } from './spendingRules.js';

// Synthetic only: an empty database made by this build, made-up GO ids and a synthetic probe row.
let template: string, dir: string, file: string, stdout: string, stderr: string;
const REFUSED = 'spending-rules: input-refused HoldrRefusal\n';
const run = (args: string[]) => runSpendingRulesCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => new Date('2026-10-21T00:00:00Z'),
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const write = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return p;
};
const goFields = (patch: Record<string, unknown> = {}) => ({
  format: 'holdr.spending-rules-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'install',
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), schemaDigest: CARD_SPENDING_RULES_SCHEMA_DIGEST,
  ...patch,
});
/** A fresh Root GO file: each has its own goId. */
const go = (patch: Record<string, unknown> = {}) => write(`go-${randomBytes(6).toString('hex')}.json`, goFields(patch));
const goIdOf = (goFile: string) => JSON.parse(fs.readFileSync(goFile, 'utf8')).goId as string;
const install = (goFile: string, backup: string) =>
  run(['install', '--db', file, '--backup', path.join(dir, backup), '--root-go', goFile]);
const plan = async () => {
  stdout = '';
  const code = await run(['plan', '--db', file]);
  const answer = JSON.parse(stdout);
  stdout = '';
  return { code, answer };
};
const planned = (schema: string, code = 'spending-rules-planned') => ({ code, schema,
  schemaDigest: CARD_SPENDING_RULES_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
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
/** Rows per table: the install writes no row anywhere. */
const rowCounts = (db: Database.Database) => Object.fromEntries(objects(db)
  .filter((object) => object.type === 'table' && !object.name.startsWith('sqlite_'))
  .map((object) => [object.name, db.prepare(`SELECT count(*) FROM "${object.name}"`).pluck().get()]));

beforeAll(async () => {
  template = await makeScratchDir('spending-rules-template-');
  const templateFile = path.join(template, 'finance.db');
  new SqliteStateRepo({ file: templateFile }).close();
  const db = new Database(templateFile);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('spending-rules-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(dir); });

describe('owner spending rules operator CLI', () => {
  it('prints its usage, and plans read-only with codes and digests only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(SPENDING_RULES_CLI_USAGE);
    stdout = '';
    const before = fs.readFileSync(file);
    expect(opened((db) => objects(db).filter((object) => object.type === 'table').length)).toBeGreaterThan(10);
    expect(await plan()).toEqual({ code: 0, answer: planned('absent') });
    expect(fs.readFileSync(file)).toEqual(before);
    for (const args of [[], ['plan'], ['plan', '--db', 'finance.db'], ['plan', '--db', file, '--db', file],
      ['plan', '--db', file, '--backup', path.join(dir, 'b.db')], ['migrate', '--db', file], ['install', '--db', file]]) {
      expect(await run(args)).toBe(1);
    }
    expect(stderr).toBe(REFUSED.repeat(7));
    stderr = '';
    const missing = path.join(dir, 'missing.db');
    expect(await run(['plan', '--db', missing])).toBe(1);
    expect(stderr).toBe('spending-rules: operation-failed SqliteError SQLITE_CANTOPEN\n');
    expect(fs.existsSync(missing)).toBe(false);
    expect(stdout).toBe('');
  });

  it('reports a conflicting object of that name, and refuses to install over it before any backup', async () => {
    for (const sql of ['CREATE TABLE card_spending_rules (id TEXT PRIMARY KEY)',
      'DROP TABLE card_spending_rules; CREATE VIEW card_spending_rules AS SELECT 1 AS synthetic']) {
      alter(sql);
      const before = opened(objects);
      expect(await plan()).toEqual({ code: 1, answer: planned('conflict', 'spending-rules-conflict') });
      stderr = '';
      expect(await install(go(), 'never.db')).toBe(1);
      expect(stderr).toBe(REFUSED);
      expect(stdout).toBe('');
      expect(fs.existsSync(path.join(dir, 'never.db'))).toBe(false);
      expect(opened(objects)).toEqual(before);
    }
  });

  it('refuses every unauthorized install before any backup or write', async () => {
    const backup = path.join(dir, 'never.db');
    const args = (goFile: string) => ['install', '--db', file, '--backup', backup, '--root-go', goFile];
    const before = opened(objects);
    const variants: Array<[string, string[]]> = [
      ['no GO', ['install', '--db', file, '--backup', backup]],
      ['an extra argument', [...args(go()), '--force', file]],
      ['relative GO path', args(path.basename(go()))],
      ['relative backup', ['install', '--db', file, '--backup', 'never.db', '--root-go', go()]],
      ['relative database', ['install', '--db', 'finance.db', '--backup', backup, '--root-go', go()]],
      ['missing GO', args(path.join(dir, 'no-go.json'))],
      ['GO is a directory', args(dir)],
      ['GO is not JSON', args(write('not-json.json', '{"format":'))],
      ['GO is an array', args(write('array.json', [goFields()]))],
      ['oversized GO', args(write('large.json', JSON.stringify(goFields()) + ' '.repeat(64 * 1024)))],
      ...([
        ['another format', { format: 'holdr.amazon-image-go' }], ['version', { version: 2 }], ['version as text', { version: '1' }],
        ['authority', { authority: 'Mac' }], ['decision', { decision: 'NO-GO' }],
        ['purpose', { purpose: 'production-import' }], ['no purpose', { purpose: undefined }],
        ['command', { command: 'plan' }],
        ['no goId', { goId: undefined }], ['malformed goId', { goId: 'not-a-nonce' }], ['capital goId', { goId: 'A'.repeat(32) }],
        ['short goId', { goId: 'a'.repeat(31) }],
        ['another database', { databaseRef: digest(path.resolve(dir, 'other.db')) }],
        ['another schema', { schemaDigest: digest('synthetic other schema') }], ['no schema', { schemaDigest: undefined }],
        ['extra field', { maxRows: 1 }],
      ] as Array<[string, Record<string, unknown>]>).map(([name, patch]): [string, string[]] => [name, args(go(patch))]),
    ];
    for (const [name, variant] of variants) {
      stderr = '';
      expect(await run(variant), name).toBe(1);
      expect(stderr, name).toBe(REFUSED);
    }
    stderr = '';
    const valid = go();
    fs.writeFileSync(path.join(dir, 'taken.db'), '');
    expect(await install(valid, 'taken.db')).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'taken.db'), 'utf8')).toBe('');
    expect(await install(valid, path.join('missing', 'backup.db'))).toBe(1);
    expect(await run(['install', '--db', file, '--backup', file, '--root-go', valid])).toBe(1);
    expect(await run(['install', '--db', file, '--backup', `${file}-journal`, '--root-go', valid])).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(4));
    for (const never of [backup, path.join(dir, 'missing'), `${file}-journal`]) expect(fs.existsSync(never), never).toBe(false);
    expect(opened(cardSpendingRulesSchemaState)).toBe('absent');
    expect(opened(objects)).toEqual(before);
    expect(stdout).toBe('');
  });

  it('installs once, after a complete pre-install backup, then reports already installed without a backup', async () => {
    // Committed but not checkpointed: a complete snapshot holds what is still only in the WAL.
    const holder = new Database(file);
    let before: ReturnType<typeof objects>, counts: Record<string, unknown>;
    const first = go();
    try {
      holder.pragma('wal_autocheckpoint = 0');
      holder.exec("CREATE TABLE synthetic_wal_probe (note TEXT); INSERT INTO synthetic_wal_probe VALUES ('synthetic')");
      before = objects(holder);
      counts = rowCounts(holder);
      expect(await install(first, 'before-rules.db')).toBe(0);
    } finally {
      holder.close();
    }
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ code: 'spending-rules-installed', purpose: 'copy-rehearsal', goId: goIdOf(first),
      schemaDigest: CARD_SPENDING_RULES_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(stdout).not.toContain(dir);
    expect(stdout.split('\n')).toHaveLength(2);

    const backup = path.join(dir, 'before-rules.db');
    expect(opened((db) => db.pragma('integrity_check', { simple: true }), backup)).toBe('ok');
    expect(opened(cardSpendingRulesSchemaState, backup)).toBe('absent');
    expect(opened(objects, backup)).toEqual(before);
    expect(opened(rowCounts, backup)).toEqual(counts);
    expect(opened((db) => db.prepare('SELECT note FROM synthetic_wal_probe').pluck().all(), backup)).toEqual(['synthetic']);

    // The table and its primary key index, nothing else, and no row written anywhere.
    expect(opened(cardSpendingRulesSchemaState)).toBe('present');
    const after = opened(objects);
    const old = new Set(before.map((object) => object.name));
    expect(after.filter((object) => old.has(object.name))).toEqual(before);
    expect(after.filter((object) => !old.has(object.name))).toEqual([
      { type: 'index', name: 'sqlite_autoindex_card_spending_rules_1', tbl_name: 'card_spending_rules', sql: null },
      { type: 'table', name: 'card_spending_rules', tbl_name: 'card_spending_rules', sql: CARD_SPENDING_RULES_SCHEMA_SQL },
    ]);
    expect(opened(rowCounts)).toEqual({ ...counts, card_spending_rules: 0 });

    // Installed: another GO, or the same one again, takes no backup and writes nothing.
    const version = opened((db) => db.pragma('schema_version', { simple: true }));
    const second = go({ purpose: 'production-install' });
    for (const [goFile, name, purpose] of [[second, 'again.db', 'production-install'], [first, 'replay.db', 'copy-rehearsal']]) {
      stdout = '';
      expect(await install(goFile, name)).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ code: 'spending-rules-already-installed', purpose, goId: goIdOf(goFile),
        schemaDigest: CARD_SPENDING_RULES_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
    }
    expect(opened((db) => db.pragma('schema_version', { simple: true }))).toBe(version);
    // Even installed, a GO for another database is refused.
    stderr = '';
    expect(await install(go({ databaseRef: digest(path.resolve(dir, 'other.db')) }), 'other.db')).toBe(1);
    expect(stderr).toBe(REFUSED);
    expect(await plan()).toEqual({ code: 0, answer: planned('present') });
  });
});
