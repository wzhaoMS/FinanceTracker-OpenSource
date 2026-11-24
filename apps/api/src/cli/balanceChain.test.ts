import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { FAKE_MACHINE, controlEnvFixture, lockHolder } from '../control/testControl.js';
import { LIFECYCLE_LOCK, lockPath } from '../control/lifecycle.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { BALANCE_CHAIN_CLI_USAGE, runBalanceChainCli } from './balanceChain.js';

// The read-only report CLI. Synthetic only: a database made by this build with a made-up checking account.

let template: string, dir: string, file: string, stdout: string, stderr: string;
const cleanups: Array<() => void> = [];
const NOW = '2026-11-03T17:00:00.000Z';
const REFUSED = 'balance-chain: input-refused HoldrRefusal\n';
const NO_CONTROL = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'HOLDR_CONTROL_DIR'));
const run = (args: string[], env: NodeJS.ProcessEnv = { ...NO_CONTROL, HOLDR_CONFIG: 'none' }) => runBalanceChainCli(args, {
  env, io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});

function seed(target: string): void {
  const repo = new SqliteStateRepo({ file: target, now: () => new Date(NOW) });
  try {
    const db = repo.internalGetDb();
    installCheckingSchema(db);
    importCheckingPayload(db, {
      format: 'holdr.checking-import', version: 1, parserVersion: 'synthetic@1',
      account: { institution: 'testbank', type: 'checking', last4: '4321', label: 'Synthetic checking', currency: 'USD' },
      segments: [{ source: 'ofx', coverage: { start: '2026-10-01', end: '2026-10-31' },
        anchors: [{ date: '2026-09-30', balanceMinor: 731_917, kind: 'opening' }, { date: '2026-10-31', balanceMinor: 726_011, kind: 'ledger' }],
        rows: [{ postedDate: '2026-10-12', amountMinor: -5_906, description: 'SYNTHETIC PAYMENT', checkNumber: null, bankType: 'DEBIT', externalIdHash: null }] }],
    }, { now: NOW, goId: 'c'.repeat(32), purpose: 'copy-rehearsal' });
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '1234', currency: 'USD' });
  } finally {
    repo.close();
  }
  const db = new Database(target);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
}

beforeAll(async () => {
  template = await makeScratchDir('balance-chain-template-');
  seed(path.join(template, 'finance.db'));
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('balance-chain-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await removeScratchDir(dir);
});

describe('holdr-balance-chain', () => {
  it('prints its usage', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(BALANCE_CHAIN_CLI_USAGE);
  });

  it('refuses without the writer\'s shared lease, and any other argument, and writes nothing', async () => {
    const before = fs.readFileSync(file);
    expect(await run(['report', '--db', file])).toBe(1);
    expect(stderr).toBe('balance-chain: report-refused no-shared-lease\n');
    expect(stdout).toBe('');
    stderr = '';
    const refused = [
      [], ['report'], ['plan', '--db', file], ['report', '--db', 'finance.db'], ['report', '--db', file, '--db', file],
      ['report', '--db', file, '--account', '1234'], ['report', '--db', file, '--account', `card-acct-${'a'.repeat(31)}`],
      ['report', '--db', file, '--detail', '--detail'], ['report', '--db', file, '--out', file], ['report', '--db'],
    ];
    for (const args of refused) expect(await run(args)).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(refused.length));
    expect(stdout).toBe('');
    expect(fs.readFileSync(file)).toEqual(before);
  });
});

describe.skipIf(process.platform !== 'darwin')('holdr-balance-chain report under the shared lease', { timeout: 60_000 }, () => {
  it('prints the report under the lease, read-only; refuses while the lifecycle lock is held exclusively', async () => {
    const control = await controlEnvFixture({ machine: FAKE_MACHINE });
    cleanups.push(control.cleanup);
    const target = path.join(control.dataDir, 'finance.db');
    seed(target);
    const before = fs.readFileSync(target);
    expect(await run(['report', '--db', target], control.env)).toBe(0);
    expect(stderr).toBe('');
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ format: 'holdr.balance-chain-report', version: 1, stores: { checking: 'present', statementFacts: 'absent' } });
    expect(report.accounts.map((account: { kind: string; state: string }) => `${account.kind}:${account.state}`)).toEqual(['checking:balanced', 'card:not-yet-checked']);
    expect(stdout.includes('731917')).toBe(false);
    expect(fs.readFileSync(target)).toEqual(before);
    stdout = '';
    const id = report.accounts[0].id as string;
    expect(await run(['report', '--db', target, '--account', id, '--detail'], control.env)).toBe(0);
    expect(JSON.parse(stdout).accounts[0].detail.steps).toEqual([{ from: '2026-09-30', to: '2026-10-31', verdict: 'pass', reason: 'exact' }]);
    stdout = '';
    await lockHolder(lockPath(control.controlDir, LIFECYCLE_LOCK), 'exclusive', cleanups);
    expect(await run(['report', '--db', target], control.env)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('operation-failed');
  });
});
