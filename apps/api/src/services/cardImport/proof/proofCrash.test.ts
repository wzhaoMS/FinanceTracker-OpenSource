import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { payloadText, ProofWorld, sha256 } from '../../../testing/cardImportProofWorld.js';

// Synthetic only. Design §6 D (crash and kill) and F (contention).
const CHILD = fileURLToPath(new URL('../../../testing/cardImportProofChild.ts', import.meta.url));
const SEPTEMBER = payloadText('amex', [
  { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
], { start: '2026-09-01', end: '2026-09-30' });
const OCTOBER = payloadText('amex', [
  { transactionDate: '2026-10-02', postedDate: '2026-10-03', amountMinor: 999, kind: 'purchase', description: 'SAMPLE STREAMING', externalId: 'proof-ref-3' },
], { start: '2026-10-01', end: '2026-10-05' }, { statement: true });
const JOB = sha256('synthetic-crash-job');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

/** A file database with an Amex card whose September is imported, the proof installed and the permit live. */
async function seededFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-import-proof-crash-synthetic-'));
  dirs.push(dir);
  const file = path.join(dir, 'finance.db');
  const w = new ProofWorld({ file });
  w.live('amex');
  const card = w.account();
  await w.seed(card, SEPTEMBER);
  w.close();
  return { dir, file, card };
}

const counts = (file: string) => {
  const db = new Database(file);
  const count = (table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
  try {
    return {
      integrity: db.pragma('integrity_check', { simple: true }),
      rows: count('card_transactions'),
      batches: count('card_import_batches'),
      receipts: count('card_import_proof_receipts'),
    };
  } finally { db.close(); }
};

/** Runs the child until it reports `stage`, then kills it outright, as a power loss or kill -9 would. */
async function killAt(dir: string, file: string, accountId: string, stage: string): Promise<void> {
  const configFile = path.join(dir, `crash-${stage}.json`);
  fs.writeFileSync(configFile, JSON.stringify({ db: file, accountId, payload: OCTOBER, jobId: JOB, stage }));
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    if (out.includes(stage)) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => { err += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  expect(out, err).toContain(stage);
  expect(out).not.toContain('finished');
}

describe('a killed proof transaction (design §6 D)', () => {
  it.each([
    ['after-apply', false],
    ['mid-gates', false],
    ['before-commit', false],
    ['after-commit', true],
  ] as const)('killed %s: integrity holds, a receipt exists exactly when the rows do, and resolve agrees', async (stage, committed) => {
    const { dir, file, card } = await seededFile();
    const before = counts(file);
    await killAt(dir, file, card.id, stage);
    const after = counts(file);
    expect(after.integrity).toBe('ok');
    expect(after).toEqual({ ...before, rows: before.rows + (committed ? 1 : 0), batches: before.batches + (committed ? 1 : 0),
      receipts: committed ? 1 : 0 });
    const w = new ProofWorld({ file });
    try {
      const resolved = await w.resolve(card, OCTOBER, JOB, 1);
      expect(resolved.status, resolved.text).toBe(200);
      expect(resolved.body.proof.outcome).toBe(committed ? 'committed' : 'not-committed');
      // The fence is durable: the killed attempt can never land later.
      const late = await w.commit(card, OCTOBER, { jobId: JOB, attempt: 1 });
      expect(late.status).toBe(committed ? 200 : 409);
      if (!committed) {
        expect(late.body.code).toBe('proof-fence-expired');
        expect((await w.commit(card, OCTOBER, { jobId: JOB, attempt: 2 })).status).toBe(201);
      }
    } finally { w.close(); }
  }, 60_000);
});

describe('lock contention (design §6 F)', () => {
  it('waits out another writer, then rolls back with proof-error and writes nothing; the same attempt then commits', async () => {
    const { file, card } = await seededFile();
    const w = new ProofWorld({ file });
    const other = new Database(file);
    try {
      const before = counts(file);
      other.exec('BEGIN IMMEDIATE');
      const busy = await w.commit(card, OCTOBER, { jobId: JOB });
      expect([busy.status, busy.body.code]).toEqual([500, 'proof-error']);
      other.exec('ROLLBACK');
      expect(counts(file)).toEqual(before);
      expect(w.logs.join('\n')).toMatch(/\[card-import-proof\] rolled back job [a-f0-9]{8}: SqliteError SQLITE_BUSY/);
      const again = await w.commit(card, OCTOBER, { jobId: JOB });
      expect(again.status, again.text).toBe(201);
    } finally {
      other.close();
      w.close();
    }
  }, 30_000);
});
