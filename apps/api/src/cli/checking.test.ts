import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { CheckingImportPayload } from '@finance-tracker/shared';

import { digest } from '../services/amazon/policy.js';
import { CHECKING_SCHEMA_DIGEST, checkingSchemaState } from '../services/checking/schema.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CHECKING_CLI_USAGE, runCheckingCli } from './checking.js';

// Synthetic only: an empty database made by this build, made-up GO ids, rows and balances.
let template: string, dir: string, file: string, stdout: string, stderr: string;
const run = (args: string[]) => runCheckingCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => new Date('2026-10-22T01:00:00Z'),
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const write = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return p;
};
const PAYLOAD: CheckingImportPayload = {
  format: 'holdr.checking-import', version: 1, parserVersion: 'holdr-checking-import@1.0.0',
  account: { institution: 'wellsfargo', type: 'checking', last4: '2931', label: 'Wells Fargo Everyday Checking', currency: 'USD' },
  segments: [{
    source: 'wf-statement', coverage: { start: '2026-09-01', end: '2026-09-30' },
    anchors: [{ date: '2026-08-31', balanceMinor: 200000, kind: 'opening' }, { date: '2026-09-30', balanceMinor: 260000, kind: 'closing' }],
    rows: [
      { postedDate: '2026-09-02', amountMinor: 100000, description: 'SYNTHETIC DEPOSIT', checkNumber: null, bankType: null, externalIdHash: null },
      { postedDate: '2026-09-20', amountMinor: -40000, description: 'CITI AUTOPAY PAYMENT ***2345 SYNTH', checkNumber: null, bankType: null, externalIdHash: null },
    ],
  }],
};
const go = (command: 'install' | 'import', patch: Record<string, unknown> = {}, payload: unknown = PAYLOAD) => write(`go-${randomBytes(6).toString('hex')}.json`, {
  format: 'holdr.checking-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command,
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), schemaDigest: CHECKING_SCHEMA_DIGEST,
  ...(command === 'import' ? { inputDigest: digest(payload) } : {}),
  ...patch,
});
const output = () => {
  const value = JSON.parse(stdout);
  stdout = '';
  return value;
};
const backup = (name: string) => path.join(dir, name);
const state = () => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return checkingSchemaState(db); } finally { db.close(); }
};
const rowCount = () => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT count(*) FROM checking_transactions').pluck().get(); } finally { db.close(); }
};

beforeAll(async () => {
  template = await makeScratchDir('checking-template-');
  const templateFile = path.join(template, 'finance.db');
  new SqliteStateRepo({ file: templateFile }).close();
  const db = new Database(templateFile);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('checking-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(dir); });

describe('checking operator CLI', () => {
  it('prints its usage, and plans read-only: schema state, digests and what an import would do', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(CHECKING_CLI_USAGE);
    stdout = '';
    const before = fs.readFileSync(file);
    expect(await run(['plan', '--db', file, '--input', write('payload.json', PAYLOAD)])).toBe(0);
    expect(output()).toEqual({
      code: 'checking-planned', schema: 'absent', schemaDigest: CHECKING_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)),
      input: { inputDigest: digest(PAYLOAD), institution: 'wellsfargo', last4: '2931', segments: 1, rows: 2, days: 30, anchors: 2,
        coverage: [{ start: '2026-09-01', end: '2026-09-30' }], bySource: { 'wf-statement': { segments: 1, rows: 2 } } },
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('installs once after a backup, then reports already installed without one', async () => {
    expect(await run(['install', '--db', file, '--backup', backup('b1.db'), '--root-go', go('install')])).toBe(0);
    expect(output()).toMatchObject({ code: 'checking-installed', purpose: 'copy-rehearsal', schemaDigest: CHECKING_SCHEMA_DIGEST });
    expect(state()).toBe('present');
    const copy = new Database(backup('b1.db'), { readonly: true });
    try { expect(checkingSchemaState(copy)).toBe('absent'); } finally { copy.close(); }
    expect(await run(['install', '--db', file, '--backup', backup('b2.db'), '--root-go', go('install')])).toBe(0);
    expect(output()).toMatchObject({ code: 'checking-already-installed' });
    expect(fs.existsSync(backup('b2.db'))).toBe(false);
  });

  it('refuses a GO that does not match, before opening the database or taking a backup', async () => {
    const before = fs.readFileSync(file);
    for (const patch of [{ format: 'holdr.spending-rules-go' }, { version: '1' }, { authority: 'root' }, { decision: 'NO-GO' }, { command: 'import' },
      { purpose: 'production-import' }, { goId: 'G'.repeat(32) }, { databaseRef: digest('/elsewhere/finance.db') }, { schemaDigest: 'f'.repeat(64) },
      { extra: true }]) {
      stderr = '';
      expect(await run(['install', '--db', file, '--backup', backup('never.db'), '--root-go', go('install', patch)])).toBe(1);
      expect(stderr).toBe('holdr-checking: input-refused HoldrRefusal\n');
    }
    expect(await run(['install', '--db', 'relative.db', '--backup', backup('never.db'), '--root-go', go('install')])).toBe(1);
    expect(fs.existsSync(backup('never.db'))).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('imports a payload its GO names after a backup; the same payload again writes nothing', async () => {
    expect(await run(['install', '--db', file, '--backup', backup('b0.db'), '--root-go', go('install')])).toBe(0);
    stdout = '';
    const input = write('payload.json', PAYLOAD);
    // A GO for another payload is refused.
    expect(await run(['import', '--db', file, '--input', input, '--backup', backup('x.db'), '--root-go', go('import', {}, { other: true })])).toBe(1);
    expect(fs.existsSync(backup('x.db'))).toBe(false);
    stderr = '';
    expect(await run(['import', '--db', file, '--input', input, '--backup', backup('b1.db'), '--root-go', go('import')])).toBe(0);
    const receipt = output();
    expect(receipt).toMatchObject({ code: 'checking-imported', rowsNew: 2, daysNew: 30, anchorsNew: 2, balanceChain: { checked: 1, gaps: 0 },
      purpose: 'copy-rehearsal', payloadDigest: digest(PAYLOAD) });
    expect(JSON.stringify(receipt)).not.toMatch(/SYNTHETIC|CITI|260000|200000|40000/);
    expect(fs.existsSync(backup('b1.db'))).toBe(true);
    expect(rowCount()).toBe(2);
    expect(await run(['import', '--db', file, '--input', input, '--backup', backup('b2.db'), '--root-go', go('import')])).toBe(0);
    expect(output()).toMatchObject({ code: 'checking-already-imported' });
    expect(fs.existsSync(backup('b2.db'))).toBe(false);
  });

  it('refuses before any backup when the tables are missing or the import would be refused, with codes and dates only', async () => {
    const input = write('payload.json', PAYLOAD);
    expect(await run(['import', '--db', file, '--input', input, '--backup', backup('b1.db'), '--root-go', go('import')])).toBe(1);
    expect(stderr).toBe('holdr-checking: input-refused HoldrRefusal\n');
    expect(fs.existsSync(backup('b1.db'))).toBe(false);
    stderr = '';
    expect(await run(['install', '--db', file, '--backup', backup('b0.db'), '--root-go', go('install')])).toBe(0);
    stdout = '';
    const broken = structuredClone(PAYLOAD);
    broken.segments[0].anchors[1].balanceMinor = 260001;
    expect(await run(['import', '--db', file, '--input', write('broken.json', broken), '--backup', backup('b2.db'), '--root-go', go('import', {}, broken)])).toBe(1);
    expect(output()).toEqual({ code: 'checking-balance-mismatch', balances: 1, dates: ['2026-09-30'] });
    expect(fs.existsSync(backup('b2.db'))).toBe(false);
    const invalid = { ...PAYLOAD, version: 2 };
    expect(await run(['import', '--db', file, '--input', write('invalid.json', invalid), '--backup', backup('b3.db'), '--root-go', go('import', {}, invalid)])).toBe(1);
    expect(output()).toEqual({ code: 'checking-payload-invalid', issues: [{ path: '$.version', message: 'must be 1' }] });
    expect(rowCount()).toBe(0);
  });
});
