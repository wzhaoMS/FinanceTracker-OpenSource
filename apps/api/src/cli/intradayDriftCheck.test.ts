import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runIntradayDriftCheck } from './intradayDriftCheck.js';

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'intraday-drift-check-')));
  dataDir = path.join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One account holding 10 SYNA beside 1,234 in cash, last changed on 10/01 and recorded by the job on 10/02, with three
 *  job ticks on Monday 2026-10-19 (1:00 to 1:10 PM ET): the line runs from 9:30 AM, and before 1:00 PM its only price
 *  is the one from 10/02. */
function seed(options: { offAt?: string } = {}) {
  const repo = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
  try {
    repo.createAccount({ id: 'acct', name: 'Synthetic', cashBalance: 1_234, currency: 'USD' });
    repo.createTransaction({ id: 'buy', accountId: 'acct', symbol: 'SYNA', date: '2026-09-01', quantity: 10, pricePerUnit: 10, currency: 'USD' });
    const db = repo.internalGetDb();
    db.prepare("UPDATE accounts SET updated_at = '2026-10-01T00:00:00.000Z'").run();
    db.prepare("UPDATE transactions SET created_at = '2026-10-01T00:00:00.000Z', updated_at = '2026-10-01T00:00:00.000Z'").run();
    db.prepare('DELETE FROM account_history_invalidations').run();
    ['2026-10-02T17:00:00.000Z', '2026-10-19T17:00:00.000Z', '2026-10-19T17:05:00.000Z', '2026-10-19T17:10:00.000Z'].forEach((t, index) => {
      const close = 99 + index;
      const recorded = 1_234 + 10 * close * (t === options.offAt ? 1.5 : 1);
      db.prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
        VALUES (?, 'acct', ?, ?, 1334, 1234)`).run(`snap-acct-${t}`, t, recorded);
      db.prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('SYNA', 'intraday', ?, ?, 'nasdaq')`).run(t, close);
    });
  } finally {
    repo.close();
  }
}

async function check(args: string[] = [], env: NodeJS.ProcessEnv = { HOLDR_DATA_DIR: dataDir, HOME: root }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runIntradayDriftCheck(args, {
    env,
    io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    now: new Date('2026-10-19T17:12:00.000Z'),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const fileHash = async () => createHash('sha256').update(await readFile(path.join(dataDir, 'finance.db'))).digest('hex');

// HOLDR_DATA_DIR is a POSIX path, as for the other operator commands.
describe.skipIf(process.platform === 'win32')('intraday drift check: the command', () => {
  it('prints the drift buckets as counts and a date only, and changes nothing', async () => {
    seed();
    const before = await fileHash();

    const result = await check();

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe([
      'Computed 1D line for the session of 2026-10-19, from stored prices only (nothing fetched or written)',
      '  points: 45, of which estimated: 42',
      '  recorded snapshots taken since the latest change to any account: 3',
      '    within 0.1%: 3',
      '    0.1% to 0.5%: 0',
      '    over 0.5%: 0',
      '  the computed line would be shown',
      '',
    ].join('\n'));
    expect(result.stdout).not.toMatch(/SYNA|acct|Synthetic|1,?234|\$/);
    expect(await fileHash()).toBe(before);
  });

  it('says when the recorded snapshots disagree', async () => {
    seed({ offAt: '2026-10-19T17:05:00.000Z' });
    const result = await check();
    expect(result.stdout).toContain('    over 0.5%: 1\n  over a tenth disagree by more than 0.5%: 1D would show the recorded snapshots instead\n');
  });

  it('checks the computed 1W line with --week, as counts and dates only', async () => {
    seed();
    const repo = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
    try {
      // A job tick on the Friday before, so the week has two sessions.
      const db = repo.internalGetDb();
      db.prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
        VALUES ('snap-acct-2026-10-16T17:00:00.000Z', 'acct', '2026-10-16T17:00:00.000Z', 2224, 1334, 1234)`).run();
      db.prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('SYNA', 'intraday', '2026-10-16T17:00:00.000Z', 99, 'nasdaq')`).run();
    } finally {
      repo.close();
    }
    const before = await fileHash();

    const result = await check(['--week']);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe('Computed 1W line for the sessions of 2026-10-16 to 2026-10-19, from stored prices only (nothing fetched or written)');
    expect(lines.slice(1, 6).every((line) => /^ {2,4}[a-z0-9.% ]+: \d+(, of which estimated: \d+)?$/.test(line))).toBe(true);
    expect(lines[6]).toBe('  the computed line would be shown');
    expect(result.stdout).not.toMatch(/SYNA|acct|Synthetic|1,?234|\$/);
    expect(await fileHash()).toBe(before);
  });

  it('refuses an unknown argument and a data dir without a database, with codes only', async () => {
    expect(await check(['--bogus'])).toMatchObject({
      code: 64, stdout: '', stderr: 'intraday-drift-check: E0I_USAGE (unexpected argument --bogus)\n',
    });
    expect(await check()).toMatchObject({
      code: 1, stdout: '', stderr: 'intraday-drift-check: E0I_DRIFT_NO_DATABASE (no finance.db in the configured data dir)\n',
    });
  });

  it('says when there is no line to compute', async () => {
    const repo = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
    repo.close();
    expect((await check()).stdout).toBe('No computed 1D line: no holdings, or no intraday price of them in the last ten days.\n');
  });
});
