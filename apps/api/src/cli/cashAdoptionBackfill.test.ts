import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FIDELITY_CASH_ADOPTED_REASON, importFidelityInvesting,
  type FidelityInvestingCapture, type FidelityInvestingPolicy,
} from '../services/fidelityInvestingSync.js';
import { getPortfolioHistory } from '../services/portfolioHistory.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createHistoryRepo } from '../services/symbolHistory.js';
import { planCashAdoptionBackfill, recordMissingCashAdoptions, runCashAdoptionBackfill } from './cashAdoptionBackfill.js';

// Monday 2026-10-19 in New York: captured at 9:18 AM, imported at 11:05 AM.
const CAPTURED = '2026-10-19T13:18:00.000Z';
const APPLIED = '2026-10-19T15:05:00.000Z';
// An attempt that held the account, and another receipt of the same capture, both before the baseline applied.
const HELD = '2026-10-19T13:20:00.000Z';
const EARLIER = '2026-10-19T14:00:00.000Z';
const sourceId = `fidelity-${'b'.repeat(64)}`;
const policy: FidelityInvestingPolicy = { bindings: [{ sourceId, last4: '4321', accountId: 'synthetic' }], ignoredSources: [] };

let root: string;
let dataDir: string;
let repo: SqliteStateRepo | null;

const openRepo = () => {
  repo = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
  return repo;
};
const db = () => repo!.internalGetDb();

function capture(cashBalance: number): FidelityInvestingCapture {
  return {
    format: 'holdr.fidelity-investing-capture', version: 1, capturedAt: CAPTURED,
    accounts: [{
      sourceId, last4: '4321', currency: 'USD', coverage: { from: '2021-10-19', to: '2026-10-19' },
      activity: [{
        key: '1'.padStart(64, '0'), date: '2026-10-01', description: 'SYNTHETIC BUY', symbol: 'SYN',
        quantity: 8, pricePerUnit: 5, amount: -40, fees: 0,
      }],
      positions: [{ symbol: 'SYN', quantity: 8, pricePerUnit: 7, costBasis: 40 }],
      cashBalance, totalValue: cashBalance + 56,
    }],
  };
}

function snapshot(time: string, marketValue: number, cash: number) {
  db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
    VALUES (?, 'synthetic', ?, ?, ?, ?)`).run(`job-${time}`, `2026-10-19T${time}:00.000Z`, marketValue, 40 + cash, cash);
}

/** A baseline imported before the importer recorded the cash it adopted: its correction is missing. */
async function importBaselineWithoutCorrection(cashBalance: number) {
  for (const time of ['13:00', '13:05', '13:10']) snapshot(time, 56, 0);
  const receipt = await importFidelityInvesting(repo!, capture(cashBalance), policy, {
    backupDirectory: path.join(root, 'backups'), now: () => new Date(APPLIED),
  });
  expect(receipt.accounts[0]).toMatchObject({ status: 'applied', baseline: true, baselineCashAdoption: true });
  db().prepare('DELETE FROM account_history_invalidations WHERE reason = ?').run(FIDELITY_CASH_ADOPTED_REASON);
  snapshot('15:10', cashBalance + 56, cashBalance);
  snapshot('15:15', cashBalance + 56.4, cashBalance);
}

const corrections = () => db().prepare(
  'SELECT account_id, effective_date, detected_at, reason FROM account_history_invalidations ORDER BY id',
).all();
const chart = () => getPortfolioHistory(
  { state: repo!, history: createHistoryRepo(repo!) }, '1D', undefined, new Date('2026-10-19T15:20:00.000Z'),
);

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'cash-adoption-backfill-')));
  dataDir = path.join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(path.join(root, 'backups'), { mode: 0o700 });
  openRepo();
  repo!.write({ accounts: [{ id: 'synthetic', name: 'Synthetic Fidelity', currency: 'USD', cashBalance: 0, accountNumber: '4321' }], transactions: [] });
  repo!.createTransaction({ id: 'legacy', accountId: 'synthetic', date: '2026-10-01', symbol: 'SYN', quantity: 8, pricePerUnit: 5, currency: 'USD' });
  db().prepare("UPDATE accounts SET updated_at = '2026-10-19T11:00:00.000Z'").run();
});

afterEach(async () => {
  repo?.close();
  repo = null;
  await rm(root, { recursive: true, force: true });
});

describe('cash adoption backfill: what it records', () => {
  it('records the missing correction once, and the 1D chart stops counting the adoption as a gain', async () => {
    await importBaselineWithoutCorrection(10);
    expect((await chart()).summary.change).toBeCloseTo(10.4, 8);
    expect(planCashAdoptionBackfill(db())).toEqual({
      baselines: 1, recorded: 0, immaterial: 0, unresolved: 0,
      pending: [{ accountId: 'synthetic', effectiveDate: '2026-10-19', detectedAt: APPLIED }],
    });
    expect(corrections()).toEqual([]);

    expect(recordMissingCashAdoptions(db()).recorded).toBe(1);
    expect(corrections()).toEqual([
      { account_id: 'synthetic', effective_date: '2026-10-19', detected_at: APPLIED, reason: FIDELITY_CASH_ADOPTED_REASON },
    ]);
    const after = await chart();
    expect(after.points.filter((point) => point.unreliable).map((point) => point.t.slice(11, 16)))
      .toEqual(['13:00', '13:05', '13:10', '13:18']);
    expect(after.summary).toMatchObject({ startValue: 66, change: expect.closeTo(0.4, 8) });

    expect(recordMissingCashAdoptions(db())).toMatchObject({ recorded: 0, plan: { recorded: 1, pending: [] } });
    expect(corrections()).toHaveLength(1);
  });

  it('matches what the importer now records itself, so it adds nothing after a fixed import', async () => {
    for (const time of ['13:00', '13:05', '13:10']) snapshot(time, 56, 0);
    await importFidelityInvesting(repo!, capture(10), policy, { backupDirectory: path.join(root, 'backups'), now: () => new Date(APPLIED) });
    expect(planCashAdoptionBackfill(db())).toMatchObject({ baselines: 1, recorded: 1, pending: [] });
  });

  it('starts the correction at the account\'s last snapshot before the capture, as the importer does', async () => {
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES ('job-fri', 'synthetic', '2026-10-16T23:55:00.000Z', 56, 40, 0)`).run();
    await importFidelityInvesting(repo!, capture(10), policy, { backupDirectory: path.join(root, 'backups'), now: () => new Date(APPLIED) });
    expect(corrections()).toEqual([
      { account_id: 'synthetic', effective_date: '2026-10-16', detected_at: APPLIED, reason: FIDELITY_CASH_ADOPTED_REASON },
    ]);
    db().prepare('DELETE FROM account_history_invalidations').run();
    expect(planCashAdoptionBackfill(db()).pending).toEqual([
      { accountId: 'synthetic', effectiveDate: '2026-10-16', detectedAt: APPLIED },
    ]);
  });

  it('leaves an adoption within two cents', async () => {
    await importBaselineWithoutCorrection(0.02);
    expect(planCashAdoptionBackfill(db())).toMatchObject({ baselines: 1, immaterial: 1, pending: [] });
  });

  it('leaves an adoption it cannot place in time, without the receipt that applied it', async () => {
    await importBaselineWithoutCorrection(10);
    db().prepare('DELETE FROM fidelity_investing_receipts').run();
    expect(recordMissingCashAdoptions(db())).toMatchObject({ recorded: 0, plan: { unresolved: 1, pending: [] } });
    expect(corrections()).toEqual([]);
  });

  it('takes the apply time from the receipt that applied the baseline, not from an attempt that held it', async () => {
    for (const time of ['13:00', '13:05', '13:10']) snapshot(time, 56, 0);
    const backupDirectory = path.join(root, 'backups');
    // The first attempt has no binding for the account yet, so it holds the account.
    const held = await importFidelityInvesting(repo!, capture(10), { bindings: [], ignoredSources: [] }, {
      backupDirectory, now: () => new Date(HELD),
    });
    expect(held.accounts[0]).toMatchObject({ status: 'held' });
    // The job keeps observing Holdr's old cash until the baseline is applied.
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES ('snap-synthetic-2026-10-19T14:00:00.000Z', 'synthetic', '2026-10-19T14:00:00.000Z', 56, 40, 0)`).run();
    const applied = await importFidelityInvesting(repo!, capture(10), policy, { backupDirectory, now: () => new Date(APPLIED) });
    expect(applied.accounts[0]).toMatchObject({ status: 'applied', baseline: true, baselineCashAdoption: true });
    // The importer's own correction is found, so nothing is added at the held attempt's time.
    expect(planCashAdoptionBackfill(db())).toMatchObject({ baselines: 1, recorded: 1, pending: [] });

    // A baseline applied before the importer recorded its correction gets the applying receipt's time.
    db().prepare('DELETE FROM account_history_invalidations WHERE reason = ?').run(FIDELITY_CASH_ADOPTED_REASON);
    expect(planCashAdoptionBackfill(db()).pending).toEqual([
      { accountId: 'synthetic', effectiveDate: '2026-10-19', detectedAt: APPLIED },
    ]);
    recordMissingCashAdoptions(db());
    snapshot('15:10', 66, 10);
    snapshot('15:15', 66.4, 10);
    const day = await chart();
    // 14:00 still held the old cash: context, not the start of the return (which would then be +10.40).
    expect(day.points.find((point) => point.t === '2026-10-19T14:00:00.000Z')).toMatchObject({ unreliable: true });
    expect(day.summary).toMatchObject({ startValue: 66, change: expect.closeTo(0.4, 8) });
  });

  it('does not guess between two receipts that applied baselines when anything was observed between them', async () => {
    await importBaselineWithoutCorrection(10);
    const digest = db().prepare('SELECT baseline_digest FROM fidelity_investing_incremental').pluck().get();
    // An earlier receipt of the same capture that applied another account's baseline.
    db().prepare(`INSERT INTO fidelity_investing_receipts (id, capture_digest, policy_digest, captured_at, imported_at, result_json)
      VALUES ('earlier', ?, 'synthetic-policy', ?, ?, ?)`).run(digest, CAPTURED, EARLIER, JSON.stringify([
      { last4: '9999', status: 'applied', added: 0, rekeyed: 0, duplicates: 0, audited: 0, baseline: true },
    ]));
    // Nothing was observed between the two, so either time draws the same charts.
    expect(planCashAdoptionBackfill(db()).pending).toEqual([
      { accountId: 'synthetic', effectiveDate: '2026-10-19', detectedAt: EARLIER },
    ]);
    // A point between them, even one of another account only, would be charted differently.
    repo!.createAccount({ id: 'other', name: 'Other', cashBalance: 0, currency: 'USD' });
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES ('snap-between', 'other', '2026-10-19T14:30:00.000Z', 100, 100, 0)`).run();
    expect(recordMissingCashAdoptions(db())).toMatchObject({ recorded: 0, plan: { unresolved: 1, pending: [] } });
    expect(corrections()).toEqual([]);
  });

  it('has nothing to do on a database that never imported from Fidelity', () => {
    expect(planCashAdoptionBackfill(db())).toEqual({ baselines: 0, recorded: 0, pending: [], immaterial: 0, unresolved: 0 });
  });
});

// HOLDR_DATA_DIR is a POSIX path, as for the other operator commands. HOME locates the (absent) holdr.conf and
// control dir; without HOLDR_CONTROL_DIR no lifecycle lease is taken, as on a stack with no control dir.
describe.skipIf(process.platform === 'win32')('cash adoption backfill: the command', () => {
  async function backfill(args: string[], env: NodeJS.ProcessEnv = { HOLDR_DATA_DIR: dataDir, HOME: root }) {
    repo?.close();
    repo = null;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCashAdoptionBackfill(args, {
      env, io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    });
    openRepo();
    return { code, stdout: out.join(''), stderr: err.join('') };
  }

  it('counts without writing, then records, then records nothing new, printing counts and dates only', async () => {
    await importBaselineWithoutCorrection(10);

    const dryRun = await backfill([]);
    expect(dryRun).toMatchObject({ code: 0, stderr: '' });
    expect(dryRun.stdout).toBe([
      "Fidelity baselines that adopted the broker's cash: 1",
      '  already recorded as history corrections: 0',
      '  to record: 1 (effective 2026-10-19)',
      "  within two cents of Holdr's cash, left as they are: 0",
      '  without their import snapshot or a receipt that tells when they were applied, left as they are: 0',
      'Dry run: nothing was written. Back up first (npm run holdr-backup), then run again with --apply.',
      '',
    ].join('\n'));
    expect(corrections()).toEqual([]);

    const applied = await backfill(['--apply']);
    expect(applied).toMatchObject({ code: 0, stderr: '' });
    expect(applied.stdout).toContain('  recorded now: 1 (effective 2026-10-19)\n');
    expect(corrections()).toHaveLength(1);

    const again = await backfill(['--apply']);
    expect(again.stdout).toContain('  already recorded as history corrections: 1\n  recorded now: 0\n');
    expect(corrections()).toHaveLength(1);
    for (const output of [dryRun.stdout, applied.stdout, again.stdout]) {
      expect(output).not.toMatch(/synthetic|4321|\$|56|66/i);
    }
  });

  it('refuses an unknown argument and a data dir without a database', async () => {
    expect(await backfill(['--bogus'])).toMatchObject({
      code: 64, stdout: '', stderr: 'cash-adoption-backfill: E0I_USAGE (unexpected argument --bogus)\n',
    });
    const empty = path.join(root, 'empty');
    await mkdir(empty, { mode: 0o700 });
    const missing = await backfill(['--apply'], { HOLDR_DATA_DIR: empty, HOME: root });
    expect(missing).toMatchObject({
      code: 1, stdout: '', stderr: 'cash-adoption-backfill: E0I_BACKFILL_NO_DATABASE (no finance.db in the configured data dir)\n',
    });
    // Another command's detail can name a private path; this one prints the code alone.
    const control = await backfill([], { HOLDR_DATA_DIR: dataDir, HOME: root, HOLDR_CONTROL_DIR: path.join(root, 'PRIVATE_HOUSEHOLD') });
    expect(control.code).not.toBe(0);
    expect(control.stderr).toMatch(/^cash-adoption-backfill: E0I_[A-Z_]+\n$/);
    expect(control.stderr).not.toContain(root);
  });
});
