import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { digest } from '../services/amazon/policy.js';
import { CARD_OPENING_MONTHS_SCHEMA_DIGEST, CARD_OPENING_MONTHS_SCHEMA_SQL, cardOpeningMonthsSchemaState,
  confirmCardOpeningMonths } from '../services/cardOpeningMonths.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CARD_OPENINGS_CLI_USAGE, runCardOpeningsCli } from './cardOpenings.js';

// Synthetic only: an empty database made by this build with two made-up card accounts, made-up GO ids and a
// synthetic probe row.
let template: string, dir: string, file: string, stdout: string, stderr: string;
let cardIds: string[];
const REFUSED = 'card-openings: input-refused HoldrRefusal\n';
const run = (args: string[]) => runCardOpeningsCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => new Date('2026-10-22T00:00:00Z'),
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const write = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return p;
};
const goFields = (patch: Record<string, unknown> = {}) => ({
  format: 'holdr.card-openings-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'install',
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), schemaDigest: CARD_OPENING_MONTHS_SCHEMA_DIGEST,
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
const planned = (schema: string, counts: Record<string, number>, code = 'card-openings-planned') => ({ code, schema, ...counts,
  schemaDigest: CARD_OPENING_MONTHS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
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
  template = await makeScratchDir('card-openings-template-');
  const templateFile = path.join(template, 'finance.db');
  const repo = new SqliteStateRepo({ file: templateFile });
  cardIds = ['4141', '4242'].map((last4) => repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4, currency: 'USD' }).id);
  repo.close();
  const db = new Database(templateFile);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('card-openings-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(dir); });

describe('card opening months operator CLI', () => {
  it('prints its usage, and plans read-only with codes, counts and digests only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(CARD_OPENINGS_CLI_USAGE);
    stdout = '';
    const before = fs.readFileSync(file);
    expect(opened((db) => objects(db).filter((object) => object.type === 'table').length)).toBeGreaterThan(10);
    expect(await plan()).toEqual({ code: 0, answer: planned('absent', { cards: 2 }) });
    expect(fs.readFileSync(file)).toEqual(before);
    for (const args of [[], ['plan'], ['plan', '--db', 'finance.db'], ['plan', '--db', file, '--db', file],
      ['plan', '--db', file, '--backup', path.join(dir, 'b.db')], ['migrate', '--db', file], ['install', '--db', file]]) {
      expect(await run(args)).toBe(1);
    }
    expect(stderr).toBe(REFUSED.repeat(7));
    stderr = '';
    const missing = path.join(dir, 'missing.db');
    expect(await run(['plan', '--db', missing])).toBe(1);
    expect(stderr).toBe('card-openings: operation-failed SqliteError SQLITE_CANTOPEN\n');
    expect(fs.existsSync(missing)).toBe(false);
    expect(stdout).toBe('');
  });

  it('reports a conflicting object of that name, and refuses to install over it before any backup', async () => {
    for (const sql of ['CREATE TABLE card_opening_months (id TEXT PRIMARY KEY)',
      'DROP TABLE card_opening_months; CREATE VIEW card_opening_months AS SELECT 1 AS synthetic']) {
      alter(sql);
      const before = opened(objects);
      expect(await plan()).toEqual({ code: 1, answer: planned('conflict', { cards: 2 }, 'card-openings-conflict') });
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
        ['the spending rules\' format', { format: 'holdr.spending-rules-go' }], ['version', { version: 2 }], ['version as text', { version: '1' }],
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
    expect(opened(cardOpeningMonthsSchemaState)).toBe('absent');
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
      expect(await install(first, 'before-openings.db')).toBe(0);
    } finally {
      holder.close();
    }
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ code: 'card-openings-installed', purpose: 'copy-rehearsal', goId: goIdOf(first),
      schemaDigest: CARD_OPENING_MONTHS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(stdout).not.toContain(dir);
    expect(stdout.split('\n')).toHaveLength(2);

    const backup = path.join(dir, 'before-openings.db');
    expect(opened((db) => db.pragma('integrity_check', { simple: true }), backup)).toBe('ok');
    expect(opened(cardOpeningMonthsSchemaState, backup)).toBe('absent');
    expect(opened(objects, backup)).toEqual(before);
    expect(opened(rowCounts, backup)).toEqual(counts);
    expect(opened((db) => db.prepare('SELECT note FROM synthetic_wal_probe').pluck().all(), backup)).toEqual(['synthetic']);

    // The table and its primary key index, nothing else, and no row written anywhere.
    expect(opened(cardOpeningMonthsSchemaState)).toBe('present');
    const after = opened(objects);
    const old = new Set(before.map((object) => object.name));
    expect(after.filter((object) => old.has(object.name))).toEqual(before);
    expect(after.filter((object) => !old.has(object.name))).toEqual([
      { type: 'index', name: 'sqlite_autoindex_card_opening_months_1', tbl_name: 'card_opening_months', sql: null },
      { type: 'table', name: 'card_opening_months', tbl_name: 'card_opening_months', sql: CARD_OPENING_MONTHS_SCHEMA_SQL },
    ]);
    expect(opened(rowCounts)).toEqual({ ...counts, card_opening_months: 0 });
    expect(await plan()).toEqual({ code: 0, answer: planned('present', { cards: 2, confirmed: 0 }) });

    // Installed: another GO, or the same one again, takes no backup and writes nothing.
    const version = opened((db) => db.pragma('schema_version', { simple: true }));
    const second = go({ purpose: 'production-install' });
    for (const [goFile, name, purpose] of [[second, 'again.db', 'production-install'], [first, 'replay.db', 'copy-rehearsal']]) {
      stdout = '';
      expect(await install(goFile, name)).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ code: 'card-openings-already-installed', purpose, goId: goIdOf(goFile),
        schemaDigest: CARD_OPENING_MONTHS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
    }
    expect(opened((db) => db.pragma('schema_version', { simple: true }))).toBe(version);
    // Even installed, a GO for another database is refused.
    stderr = '';
    expect(await install(go({ databaseRef: digest(path.resolve(dir, 'other.db')) }), 'other.db')).toBe(1);
    expect(stderr).toBe(REFUSED);

    // Counts only: how many cards have a month in force, never which or what. These cards have no rows or imports.
    const db = new Database(file);
    const noData = () => new Map<string, string | null>();
    try {
      confirmCardOpeningMonths(db, [{ cardAccountId: cardIds[0], openingMonth: '2024-03' }], {
        actorRef: `usr_${'a'.repeat(32)}`, now: '2026-10-22T00:00:00.000Z' }, noData);
      confirmCardOpeningMonths(db, [{ cardAccountId: cardIds[0], openingMonth: '2024-02' }], {
        actorRef: `usr_${'a'.repeat(32)}`, now: '2026-10-22T00:00:01.000Z' }, noData);
    } finally {
      db.close();
    }
    const { answer } = await plan();
    expect(answer).toEqual(planned('present', { cards: 2, confirmed: 1 }));
    expect(JSON.stringify(answer)).not.toMatch(/2024|card-acct/);
  });
});
