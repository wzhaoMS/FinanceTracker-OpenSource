import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { digest } from '../services/amazon/policy.js';
import { PROOF_PERMIT_JOURNAL_TABLE, PROOF_SCHEMA_DIGEST, proofSchemaState } from '../services/cardImport/proof/schema.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { payloadText, ProofWorld, sha256 } from '../testing/cardImportProofWorld.js';
import { tablesAndCounts } from '../testing/sqliteContents.js';
import { runCardImportProofCli } from './cardImportProof.js';

// Synthetic only: an empty database made by this build, made-up GO ids and synthetic rows.
let dir: string, file: string, stdout: string, stderr: string;
const run = (args: string[], now = new Date('2026-10-20T12:00:00Z')) => {
  stdout = '';
  stderr = '';
  return runCardImportProofCli(args, {
    env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => now,
    io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
  }).then(checkedExit);
};
const out = () => stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
const writeGo = (fields: Record<string, unknown>) => {
  const target = path.join(dir, `go-${randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(target, JSON.stringify(fields), { mode: 0o600 });
  return target;
};
const goBase = () => ({ format: 'holdr.card-import-proof-go', version: 1, authority: 'Root', decision: 'GO',
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)) });
const installGo = (patch: Record<string, unknown> = {}) => writeGo({ ...goBase(), purpose: 'copy-rehearsal', command: 'install',
  schemaDigest: PROOF_SCHEMA_DIGEST, ...patch });
const liveGo = (scope: string, mode: string, patch: Record<string, unknown> = {}) => writeGo({ ...goBase(), purpose: 'production-permit',
  command: 'permit-live', scope, mode, ...patch });
const schemaOf = () => {
  const db = new Database(file, { readonly: true });
  try { return proofSchemaState(db); } finally { db.close(); }
};
/** Every table of a database file with its row count (testing/sqliteContents.ts). */
const contentsOf = (target: string) => {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return tablesAndCounts(db); } finally { db.close(); }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-import-proof-cli-synthetic-'));
  file = path.join(dir, 'finance.db');
  new SqliteStateRepo({ file }).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('holdr-card-import-proof install', () => {
  it('plans read-only, refuses any GO not pinned to this database and schema, then installs once with a backup', async () => {
    expect(await run(['plan', '--db', file])).toBe(0);
    expect(out()).toEqual([{ code: 'card-import-proof-planned', schema: 'absent', schemaDigest: PROOF_SCHEMA_DIGEST,
      databaseRef: digest(path.resolve(file)) }]);
    for (const go of [installGo({ schemaDigest: 'a'.repeat(64) }), installGo({ databaseRef: 'b'.repeat(64) }),
      installGo({ authority: 'Someone' }), installGo({ command: 'permit-live' }), installGo({ extra: true })]) {
      expect(await run(['install', '--db', file, '--backup', path.join(dir, 'never.db'), '--root-go', go])).toBe(1);
      expect(stderr).toBe('card-import-proof: input-refused HoldrRefusal\n');
    }
    expect(fs.existsSync(path.join(dir, 'never.db'))).toBe(false);
    expect(schemaOf()).toBe('absent');
    // Synthetic rows, so that the backup's row counts show its content: an empty backup passes a check that it exists.
    const seed = new Database(file);
    try {
      seed.exec('CREATE TABLE synthetic_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      seed.exec("INSERT INTO synthetic_rows (label) VALUES ('synthetic-a'), ('synthetic-b')");
    } finally { seed.close(); }
    const before = contentsOf(file);
    expect(before).toContainEqual(['synthetic_rows', 2]);
    const backup = path.join(dir, 'pre-install.db');
    expect(await run(['install', '--db', file, '--backup', backup, '--root-go', installGo()])).toBe(0);
    expect(out()[0]).toMatchObject({ code: 'card-import-proof-installed', schemaDigest: PROOF_SCHEMA_DIGEST });
    expect(fs.existsSync(backup)).toBe(true);
    // The backup is the database as it was before the install: every table with its row count, and no proof table.
    expect(contentsOf(backup)).toEqual(before);
    expect(schemaOf()).toBe('present');
    expect(await run(['install', '--db', file, '--backup', path.join(dir, 'again.db'), '--root-go', installGo()])).toBe(0);
    expect(out()[0]).toMatchObject({ code: 'card-import-proof-already-installed' });
    expect(fs.existsSync(path.join(dir, 'again.db'))).toBe(false);
  });
});

describe('holdr-card-import-proof permit', () => {
  async function installed() {
    expect(await run(['install', '--db', file, '--backup', path.join(dir, 'pre-install.db'), '--root-go', installGo()])).toBe(0);
  }

  it('starts dead; stop needs no GO and reads its generation back; live needs a single-use GO naming scope and mode', async () => {
    await installed();
    expect(await run(['permit', 'status', '--db', file])).toBe(0);
    expect(out()).toEqual([{ code: 'card-import-proof-permit-status', rows: [] }]);
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'all', '--reason', 'operator-stop',
      '--declared-at', '2026-10-20T11:59:00Z'])).toBe(0);
    // Step (a) of STOPPING-PENDING only: the row as read back, and nothing that claims the STOP is complete.
    expect(out()).toEqual([{ code: 'permit-stop-applied', scope: '*', state: 'dead', generation: 1, reason: 'operator-stop',
      declaredAt: '2026-10-20T11:59:00.000Z', declaredAtClamped: false }]);
    const go = liveGo('amex', 'daily-interim');
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'daily-interim', '--root-go', go])).toBe(0);
    expect(out()[0]).toMatchObject({ code: 'permit-live', scope: 'amex', state: 'live', mode: 'daily-interim', generation: 1 });
    // A GO is used once, names exactly this scope and mode, and is pinned to this database.
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'daily-interim', '--root-go', go])).toBe(1);
    expect(await run(['permit', 'live', '--db', file, '--scope', 'citi', '--mode', 'auto', '--root-go', liveGo('amex', 'auto')])).toBe(1);
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'auto', '--root-go', liveGo('amex', 'daily-interim')])).toBe(1);
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'supervised', '--root-go', liveGo('amex', 'supervised')])).toBe(1);
    expect(await run(['permit', 'live', '--db', file, '--scope', 'all', '--mode', 'auto',
      '--root-go', liveGo('*', 'auto', { databaseRef: 'c'.repeat(64) })])).toBe(1);
    // A STOP must say when it was declared, in ISO UTC, and give one of the permit's reasons.
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'amex', '--reason', 'consent-off'])).toBe(1);
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'amex', '--reason', 'consent-off',
      '--declared-at', '2026-10-21 00:00'])).toBe(1);
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'amex', '--reason', 'unknown', '--declared-at', '2026-10-20T11:00:00Z'])).toBe(1);
    expect(await run(['permit', 'status', '--db', file])).toBe(0);
    expect((out()[0].rows as Array<Record<string, unknown>>).map((row) => [row.scope, row.state, row.generation]))
      .toEqual([['*', 'dead', 1], ['amex', 'live', 1]]);
    // Never refused for being ahead of this clock (969): recorded when the generation it ends went live.
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'amex', '--reason', 'consent-off',
      '--declared-at', '2026-10-21T00:00:00Z'])).toBe(0);
    expect(out()).toEqual([{ code: 'permit-stop-applied', scope: 'amex', state: 'dead', generation: 2, reason: 'consent-off',
      declaredAt: '2026-10-20T12:00:00.000Z', declaredAtClamped: true }]);
  });

  it('re-issues a live row in place under a new GO: the GO\'s mode, the next generation, and no STOP in the journal', async () => {
    await installed();
    expect(await run(['permit', 'live', '--db', file, '--scope', 'all', '--mode', 'daily-interim', '--root-go', liveGo('*', 'daily-interim')]))
      .toBe(0);
    const first = liveGo('amex', 'daily-interim');
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'daily-interim', '--root-go', first])).toBe(0);
    // daily-interim to auto on the live row, with no stop between (W2's C10.7).
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'auto', '--root-go', liveGo('amex', 'auto')])).toBe(0);
    expect(out()[0]).toMatchObject({ code: 'permit-live', scope: 'amex', state: 'live', mode: 'auto', generation: 2 });
    expect(await run(['permit', 'live', '--db', file, '--scope', 'amex', '--mode', 'daily-interim', '--root-go', first])).toBe(1);
    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare(`SELECT issuer, state, mode, generation, go_id IS NOT NULL, declared_at IS NULL FROM ${PROOF_PERMIT_JOURNAL_TABLE}
        ORDER BY issuer, generation`).raw().all())
        .toEqual([['*', 'live', 'daily-interim', 1, 1, 1], ['amex', 'live', 'daily-interim', 1, 1, 1], ['amex', 'live', 'auto', 2, 1, 1]]);
    } finally { db.close(); }
  });

  it('refuses permit commands before the proof tables are installed', async () => {
    expect(await run(['permit', 'status', '--db', file])).toBe(1);
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'all', '--reason', 'operator-stop',
      '--declared-at', '2026-10-20T11:59:00Z'])).toBe(1);
    expect(stderr).toBe('card-import-proof: input-refused HoldrRefusal\n');
  });
});

describe('holdr-card-import-proof receipts (STOPPING-PENDING)', () => {
  it('lists value-free receipts and labels one committed after a later STOP was declared', async () => {
    fs.rmSync(file);
    const w = new ProofWorld({ file });
    w.live('amex');
    const card = w.account();
    await w.seed(card, payloadText('amex', [{ transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200,
      kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' }], { start: '2026-09-01', end: '2026-09-30' }));
    const jobId = sha256('synthetic-cli-job');
    const res = await w.commit(card, payloadText('amex', [{ transactionDate: '2026-10-02', postedDate: '2026-10-03', amountMinor: 999,
      kind: 'purchase', description: 'SAMPLE STREAMING', externalId: 'proof-ref-3' }], { start: '2026-10-01', end: '2026-10-05' },
    { statement: true }), { jobId });
    expect(res.status, res.text).toBe(201);
    const committedAt = res.body.proof.committedAt as string;
    w.close();
    const now = new Date(Date.parse(committedAt) + 60_000);
    expect(await run(['receipts', '--db', file, '--since', new Date(Date.parse(committedAt) - 300_000).toISOString()], now)).toBe(0);
    expect(out()).toEqual([
      { job: jobId.slice(0, 8), mode: 'automatic', route: 'commit', outcome: 'committed', committedAt,
        permit: { globalGeneration: 1, issuerGeneration: 1 }, label: 'committed' },
      { code: 'card-import-proof-receipts', since: new Date(Date.parse(committedAt) - 300_000).toISOString(), count: 1,
        committedDuringStopping: 0 },
    ]);
    expect(stdout).not.toMatch(/NORTHWIND|SAMPLE|4200|999/);
    expect(await run(['permit', 'stop', '--db', file, '--scope', 'amex', '--reason', 'consent-off',
      '--declared-at', new Date(Date.parse(committedAt) - 1000).toISOString()], now)).toBe(0);
    expect(out()[0]).toMatchObject({ code: 'permit-stop-applied', scope: 'amex', generation: 2 });
    expect(await run(['receipts', '--db', file, '--since', new Date(Date.parse(committedAt) - 300_000).toISOString()], now)).toBe(0);
    expect(out()[0]).toMatchObject({ label: 'committed-during-stopping' });
    expect(out()[1]).toMatchObject({ count: 1, committedDuringStopping: 1 });
    // Astra's must-have: the label is metadata about receipts, never a STOP's completion. "Stopped" needs W16's readback
    // and every in-flight job's proven outcome; nothing W4 prints says otherwise.
    expect(Object.keys(out()[1]).sort()).toEqual(['code', 'committedDuringStopping', 'count', 'since']);
    expect(stdout).not.toMatch(/"stopped"|"complete"|stopComplete|stoppedAt/i);
    // A job still in flight at the STOP is settled only by its own outcome: resolve fences and answers it.
    const inFlight = new ProofWorld({ file });
    try {
      const resolved = await inFlight.resolve(card, payloadText('amex', [{ transactionDate: '2026-10-06', postedDate: '2026-10-07',
        amountMinor: 500, kind: 'purchase', description: 'TAILSPIN', externalId: 'proof-ref-6' }], { start: '2026-10-06', end: '2026-10-08' },
      { statement: true }), sha256('synthetic-in-flight-job'), 1);
      expect(resolved.body).toEqual({ proof: { outcome: 'not-committed' } });
    } finally { inFlight.close(); }
    expect(await run(['receipts', '--db', file, '--since', new Date(Date.parse(committedAt) + 1000).toISOString()], now)).toBe(0);
    expect(out()).toEqual([{ code: 'card-import-proof-receipts', since: new Date(Date.parse(committedAt) + 1000).toISOString(),
      count: 0, committedDuringStopping: 0 }]);
  });
});

/**
 * The CLI's exit code. An unexpected error, which the CLI reports as operation-failed, fails the test as an error, never
 * as an exit code an assertion reads (ROOT's kill standard, addendum 3 (e)); a declared refusal (input-refused) stays a code.
 */
function checkedExit(code: number): number {
  if (/^card-import-proof: operation-failed /m.test(stderr)) throw new Error(`the CLI failed unexpectedly: ${stderr.trim()}`);
  return code;
}
