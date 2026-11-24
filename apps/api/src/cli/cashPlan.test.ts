import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { digest } from '../services/amazon/policy.js';
import { CASH_PLAN_SCHEMA_DIGEST, cashPlanSchemaState, listCardScheduleObservations } from '../services/cashPlan.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CASH_PLAN_CLI_USAGE, runCashPlanCli } from './cashPlan.js';
import { cashPlanReport, formatCashPlanReport, type CashPlanReport } from './cashPlanReport.js';

// Synthetic only: a database made by this build with made-up cards, made-up GO ids and synthetic observations.

let template: string, dir: string, file: string, stdout: string, stderr: string;
const NOW = new Date('2026-11-03T17:00:00.000Z');
const REFUSED = 'cash-plan: input-refused HoldrRefusal\n';
const NO_CONTROL = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'HOLDR_CONTROL_DIR'));
const run = (args: string[]) => runCashPlanCli(args, {
  env: { ...NO_CONTROL, HOLDR_CONFIG: 'none' }, now: () => NOW,
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const write = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return p;
};
const sha256 = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const goFields = (patch: Record<string, unknown> = {}) => ({
  format: 'holdr.cash-plan-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'install',
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), schemaDigest: CASH_PLAN_SCHEMA_DIGEST, ...patch,
});
const go = (patch: Record<string, unknown> = {}) => write(`go-${randomBytes(6).toString('hex')}.json`, goFields(patch));
const install = (goFile: string, backup: string) => run(['install', '--db', file, '--backup', path.join(dir, backup), '--root-go', goFile]);
const opened = <T>(fn: (db: Database.Database) => T, target = file) => {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
};
const observation = (patch: Record<string, unknown> = {}) => ({
  card: { issuer: 'testbank', last4: '1234' }, currency: 'USD', sourceKind: 'statement-pdf', sourceRef: `sha256:${'f'.repeat(64)}`,
  observedAt: '2026-10-13T12:00:00Z', extractorVersion: 'synthetic@1', asOf: { source: 'statement', at: '2026-10-11', precision: 'date' },
  statementClosingDate: '2026-10-11', paymentDueDate: '2026-11-06', statementBalanceMinor: 20000, minimum: { minor: 5000, basis: 'total-due' },
  pastDueMinor: 0, ...patch,
});
const observationsFile = (observations: unknown[], name = 'observations.json') =>
  write(name, { format: 'holdr.card-schedule-observations', version: 1, observations });
const importGo = (fileOf: string, patch: Record<string, unknown> = {}) => go({ command: 'import', inputSha256: sha256(fileOf), ...patch });
const doImport = (goFile: string, fileOf: string, backup: string) =>
  run(['import', '--db', file, '--backup', path.join(dir, backup), '--root-go', goFile, '--observations', fileOf]);

beforeAll(async () => {
  template = await makeScratchDir('cash-plan-template-');
  const templateFile = path.join(template, 'finance.db');
  const repo = new SqliteStateRepo({ file: templateFile });
  repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
  repo.close();
  const db = new Database(templateFile);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('cash-plan-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(dir); });

describe('holdr-cash plan and install', () => {
  it('prints its usage, and plans read-only with codes and digests only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(CASH_PLAN_CLI_USAGE);
    stdout = '';
    const before = fs.readFileSync(file);
    expect(await run(['plan', '--db', file])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'cash-plan-planned', schema: 'absent', schemaDigest: CASH_PLAN_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('refuses a GO that is not exactly a Root GO for this database, schema and command, before any backup or write', async () => {
    const before = fs.readFileSync(file);
    const bad = [
      go({ format: 'holdr.spending-rules-go' }), go({ version: 2 }), go({ authority: 'Alex' }), go({ decision: 'HOLD' }), go({ purpose: 'production' }),
      go({ command: 'import' }), go({ goId: 'G'.repeat(32) }), go({ databaseRef: digest('/elsewhere/finance.db') }), go({ schemaDigest: 'a'.repeat(64) }),
      write('extra.json', { ...goFields(), note: 'x' }), write('not-json.json', '{'),
    ];
    for (const goFile of bad) expect(await install(goFile, `backup-${randomBytes(4).toString('hex')}.db`)).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(bad.length));
    expect(stdout).toBe('');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('backup-'))).toEqual([]);
    for (const args of [['install', '--db', file], ['install', '--db', 'finance.db', '--backup', path.join(dir, 'b.db'), '--root-go', go()], ['nonsense']]) {
      stderr = '';
      expect(await run(args)).toBe(1);
      expect(stderr).toBe(REFUSED);
    }
  });

  it('installs once after a pre-install backup; a second install reports already installed with no backup', async () => {
    expect(await install(go(), 'backup-1.db')).toBe(0);
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({ code: 'cash-plan-installed', purpose: 'copy-rehearsal', schemaDigest: CASH_PLAN_SCHEMA_DIGEST });
    expect(opened(cashPlanSchemaState)).toBe('present');
    expect(opened(cashPlanSchemaState, path.join(dir, 'backup-1.db'))).toBe('absent');
    stdout = '';
    expect(await install(go(), 'backup-2.db')).toBe(0);
    expect(JSON.parse(stdout).code).toBe('cash-plan-already-installed');
    expect(fs.existsSync(path.join(dir, 'backup-2.db'))).toBe(false);
  });

  it('a conflict plans as conflict (exit 1) and is never installed over', async () => {
    const db = new Database(file);
    try { db.exec('CREATE TABLE card_schedule_observations (id TEXT)'); } finally { db.close(); }
    expect(await run(['plan', '--db', file])).toBe(1);
    expect(JSON.parse(stdout).code).toBe('cash-plan-conflict');
    stdout = '';
    expect(await install(go(), 'backup-c.db')).toBe(1);
    expect(stderr).toBe(REFUSED);
    expect(fs.existsSync(path.join(dir, 'backup-c.db'))).toBe(false);
  });
});

describe('holdr-cash import', () => {
  it('imports a GO-pinned file after a backup; the same file again is already imported, with no backup', async () => {
    expect(await install(go(), 'backup-i.db')).toBe(0);
    stdout = '';
    const input = observationsFile([observation(), observation({ card: { issuer: 'nobank', last4: '0000' } }),
      observation({ statementClosingDate: '2026-09-11', paymentDueDate: '2026-10-06', asOf: { source: 'statement', at: '2026-09-11', precision: 'date' }, minimum: { minor: 5000 } })]);
    const goFile = importGo(input);
    expect(await doImport(goFile, input, 'backup-1.db')).toBe(0);
    const receipt = JSON.parse(stdout);
    expect(receipt).toEqual({ code: 'cash-plan-imported', goId: JSON.parse(fs.readFileSync(goFile, 'utf8')).goId, inputSha256: sha256(input),
      inserted: 3, duplicates: 0, held: { unbound: 1, 'minimum-basis': 1 }, cards: 1, dueDateRange: { from: '2026-10-06', to: '2026-11-06' } });
    expect(fs.existsSync(path.join(dir, 'backup-1.db'))).toBe(true);
    expect(opened((db) => listCardScheduleObservations(db).length)).toBe(3);
    expect(opened((db) => listCardScheduleObservations(db).every((o) => o.importRef === `sha256:${sha256(input)}`))).toBe(true);
    stdout = '';
    expect(await doImport(importGo(input), input, 'backup-2.db')).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'cash-plan-already-imported', inserted: 0, duplicates: 3 });
    expect(fs.existsSync(path.join(dir, 'backup-2.db'))).toBe(false);
  });

  it('refuses a GO not pinned to the file, a file before the table, and any invalid observation (naming index and field only)', async () => {
    const input = observationsFile([observation()]);
    expect(await doImport(importGo(input), input, 'backup-0.db')).toBe(1);
    expect(stderr).toBe(REFUSED);
    expect(fs.existsSync(path.join(dir, 'backup-0.db'))).toBe(false);
    expect(await install(go(), 'backup-i.db')).toBe(0);
    stdout = ''; stderr = '';
    expect(await doImport(importGo(input, { inputSha256: 'a'.repeat(64) }), input, 'backup-1.db')).toBe(1);
    expect(await doImport(go({ command: 'import' }), input, 'backup-2.db')).toBe(1);
    expect(await doImport(importGo(input, { command: 'install' }), input, 'backup-3.db')).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(3));
    stderr = '';
    const invalid = observationsFile([observation(), observation({ pastDueMinor: -12345 })], 'invalid.json');
    expect(await doImport(importGo(invalid), invalid, 'backup-4.db')).toBe(1);
    expect(stderr).toBe('cash-plan: input-refused observation 1 pastDueMinor\n');
    stderr = '';
    for (const body of [{ format: 'holdr.card-schedule-observations', version: 2, observations: [observation()] },
      { format: 'other', version: 1, observations: [observation()] }, { format: 'holdr.card-schedule-observations', version: 1, observations: [] },
      { format: 'holdr.card-schedule-observations', version: 1, observations: [observation()], extra: true }]) {
      const fileOf = write(`bad-${randomBytes(4).toString('hex')}.json`, body);
      expect(await doImport(importGo(fileOf), fileOf, `backup-${randomBytes(4).toString('hex')}.db`)).toBe(1);
    }
    expect(stderr).toBe(REFUSED.repeat(4));
    const big = write('big.json', ' '.repeat(1024 * 1024 + 1));
    stderr = '';
    expect(await doImport(importGo(big), big, 'backup-5.db')).toBe(1);
    expect(stderr).toBe(REFUSED);
    expect(opened((db) => listCardScheduleObservations(db).length)).toBe(0);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('backup-') && name !== 'backup-i.db')).toEqual([]);
  });
});

describe('holdr-cash report', () => {
  it('refuses without the writer\'s shared lease, and unknown arguments', async () => {
    const before = fs.readFileSync(file);
    expect(await run(['report', '--db', file])).toBe(1);
    expect(stderr).toBe('cash-plan: report-refused no-shared-lease\n');
    expect(stdout).toBe('');
    stderr = '';
    for (const args of [['report'], ['report', '--db', 'finance.db'], ['report', '--db', file, '--out', file]]) expect(await run(args)).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(3));
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('counts and one date only, under a strict schema', async () => {
    expect(opened((db) => cashPlanReport(db, NOW))).toEqual({ code: 'cash-plan-report', schema: 'absent', activeCards: 1, cardsWithCycle: 0,
      red: {}, amber: {}, held: 0, newestAsOf: null });
    expect(await install(go(), 'backup-i.db')).toBe(0);
    const input = observationsFile([observation(), observation({ card: { issuer: 'nobank', last4: '0000' } })]);
    expect(await doImport(importGo(input), input, 'backup-1.db')).toBe(0);
    const report = opened((db) => cashPlanReport(db, NOW));
    expect(report).toEqual({ code: 'cash-plan-report', schema: 'present', activeCards: 1, cardsWithCycle: 1, red: {}, amber: { A1: 1, A2b: 1 },
      held: 1, newestAsOf: '2026-10-11' });
    const line = formatCashPlanReport(report)!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line).not.toMatch(/[0-9]{5,}/);
    const bad: Array<Partial<CashPlanReport> & Record<string, unknown>> = [
      { ...report, newestAsOf: '20261011' }, { ...report, red: { A1: 1 } }, { ...report, amber: { R2a: 1 } }, { ...report, held: 123456 },
      { ...report, extra: 'x' }, { ...report, amber: { A11: 1.5 } },
    ];
    for (const item of bad) expect(formatCashPlanReport(item as CashPlanReport)).toBeNull();
  });
});
