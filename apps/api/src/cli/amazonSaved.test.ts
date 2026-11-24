import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runAmazonCli } from './amazon.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from '../services/amazon/importer.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { rootApproval, syntheticCompleteCapture } from '../services/amazon/fixtures.testSupport.js';
import { digest, LEDGER_POLICY_DIGEST, opaque, POLICY_DIGEST } from '../services/amazon/policy.js';
import { AMAZON_SCHEMA_DIGEST } from '../services/amazon/schema.js';
import {
  KIT_ORDER, KIT_SECRETS, SAVED_CHARGES, SAVED_SECRETS, kitConflict, syntheticSavedOrders,
} from '../services/amazon/savedOrdersFixtures.testSupport.js';
import { readCurrentUserSid, restrictToUser } from '../e2e/windowsAcl.js';

let dir: string, file: string, stdout: string, stderr: string, inputs: string, clones: string, cloneNumber = 0;
const run = (args: string[]) => {
  stdout = ''; stderr = '';
  return runAmazonCli(args, { env: { ...process.env, HOLDR_CONFIG: 'none' },
    io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } } });
};
/** An operator file: owner-only, in the operator's owner-only inputs directory. */
const json = (name: string, value: unknown, where = inputs) => {
  const p = path.join(where, name);
  fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
  return p;
};
const writeGo = (command: string, input: unknown) => json(`write-go-${randomBytes(6).toString('hex')}.json`, {
  format: 'holdr.amazon-write-go', version: 2, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command,
  databaseRef: digest(path.resolve(file)), inputDigest: digest(input), policyDigest: POLICY_DIGEST, schemaDigest: AMAZON_SCHEMA_DIGEST,
  ledgerPolicyDigest: LEDGER_POLICY_DIGEST,
});
function privateDir(name: string): string {
  const out = path.join(fs.realpathSync(dir), name);
  fs.mkdirSync(out);
  if (process.platform === 'win32') restrictToUser(out, readCurrentUserSid());
  else fs.chmodSync(out, 0o700);
  return out;
}
/** Lets everyone read `target`: no longer owner-only (Windows: an Everyone ACE; elsewhere mode 644). */
function widen(target: string): void {
  if (process.platform === 'win32') execFileSync('icacls', [target, '/grant', '*S-1-1-0:R'], { stdio: 'ignore', windowsHide: true });
  else fs.chmodSync(target, 0o644);
}
const clone = () => path.join(clones, `clone-${++cloneNumber}.db`);
function opened<T>(target: string, fn: (db: Database.Database) => T): T {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}
const rows = (table: string) => opened(file, db => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number);
const hasTable = (table: string) => opened(file, db =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const shown = (orderId: string) => opened(file, db => ({
  order: db.prepare('SELECT latest_digest,data_json FROM amazon_orders WHERE ref=?').get(opaque('order', orderId)),
  history: db.prepare('SELECT count(*) FROM amazon_observations WHERE order_ref=?').pluck().get(opaque('order', orderId)),
  match: db.prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck().get(opaque('order-total', orderId)),
}));
const output = () => JSON.parse(stdout.trim());
const valueFree = () => { for (const secret of [...SAVED_SECRETS, ...KIT_SECRETS]) expect(stdout + stderr).not.toContain(secret); };
/** The synthetic file with its classic order dated where no card charge settles it. */
const lonely = () => { const saved = syntheticSavedOrders(); saved.orders[0].date = '2026-06-01'; return saved; };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-saved-cli-synthetic-'));
  file = path.join(dir, 'finance.db');
  // The household's database: one bound card with the two charges that settle the synthetic saved orders.
  const repo = new SqliteStateRepo({ file }), db = repo.internalGetDb(), setup = privateDir('setup');
  try {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: SAVED_CHARGES.map(c => ({ ...c, status: 'posted', kind: 'purchase', currency: 'USD', description: 'AMAZON SYNTHETIC',
        issuerCategory: 'Shopping' })) });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db));
    await recordBindingProposal(db, proposal, path.join(setup, 'proposal.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(setup, 'approval.db'));
  } finally { repo.close(); }
  inputs = privateDir('inputs');
  clones = privateDir('clones');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('preview-saved (the clone gate)', () => {
  it('previews on a new private clone, never writes the database, holds what fails, and writes only passing orders', async () => {
    const saved = lonely();
    const input = json('saved.json', saved), gated = path.join(clones, 'gated.json'), target = clone();
    const bytes = fs.readFileSync(file);
    expect(await run(['preview-saved', '--db', file, '--clone', target, '--input', input, '--output', gated])).toBe(0);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    const out = output();
    expect(out).toMatchObject({ code: 'saved-previewed', inputDigest: digest(saved), orders: 2, valid: 2, invalid: [],
      trial: { passed: 1, failed: 1, reasons: { 'held:no-candidate': 1 }, ledgerCodes: { 'ledger-none': 1 } },
      written: { orders: 1, freshLists: 1, gate: { passed: 1, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0, ledgerCodes: {} } },
      gated: { orders: 1, written: true } });
    expect(out.held.map((o: { index: number; state: string }) => [o.index, o.state])).toEqual([[0, 'held']]);
    const written = JSON.parse(fs.readFileSync(gated, 'utf8'));
    expect(written.orders.map((o: { orderId: string }) => o.orderId)).toEqual([saved.orders[1].orderId]);
    expect(out.gated.inputDigest).toBe(digest(written));
    valueFree();
  });
  it('sets aside an invalid order by place and reason, and previews its valid sibling', async () => {
    const saved = syntheticSavedOrders();
    (saved.orders[1].fresh!.lines[1] as { weight: { value: unknown } }).weight.value = 2.5;
    const gated = path.join(clones, 'gated.json');
    expect(await run(['preview-saved', '--db', file, '--clone', clone(), '--input', json('bad.json', saved), '--output', gated])).toBe(0);
    expect(output()).toMatchObject({ code: 'saved-previewed', orders: 2, valid: 1, invalid: [{ index: 1, reason: 'fresh-line' }],
      held: [], written: { orders: 1, gate: { passed: 1 } }, gated: { orders: 1 } });
    expect(JSON.parse(fs.readFileSync(gated, 'utf8')).orders.map((o: { orderId: string }) => o.orderId))
      .toEqual([saved.orders[0].orderId]);
    valueFree();
  });
  it('refuses a file outside the closed envelope whole, before any clone', async () => {
    const saved = syntheticSavedOrders();
    saved.provenance.indexSha256 = 'not-a-digest';
    const target = clone();
    expect(await run(['preview-saved', '--db', file, '--clone', target, '--input', json('bad.json', saved)])).toBe(1);
    expect(output()).toEqual({ code: 'saved-input-refused', index: null, reason: 'provenance' });
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('a saved-orders input must be owner-only (assertPrivate; never repaired)', () => {
  it('refuses a widened input file and one in a shared directory, before any clone or backup', async () => {
    const saved = syntheticSavedOrders(), widened = json('widened.json', saved);
    widen(widened);
    // An owner-only file in a directory others can read: written first, then the directory widened.
    const sharedDir = privateDir('shared'), shared = json('shared.json', saved, sharedDir);
    widen(sharedDir);
    const target = clone(), backup = path.join(dir, 'b-private.db');
    for (const input of [widened, shared]) {
      expect(await run(['preview-saved', '--db', file, '--clone', target, '--input', input])).toBe(1);
      expect(stderr).toContain('input-refused');
      expect(await run(['import-saved', '--db', file, '--input', input, '--backup', backup,
        '--root-go', writeGo('import-saved', saved)])).toBe(1);
      expect(stderr).toContain('input-refused');
    }
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
  });
});

describe('import-saved (Root GO, backup, the per-order gate inside the write)', () => {
  it('refuses without a matching GO, and imports a GO-named file after a backup', async () => {
    const saved = syntheticSavedOrders(), input = json('saved.json', saved);
    expect(await run(['import-saved', '--db', file, '--input', input, '--backup', path.join(dir, 'b0.db'),
      '--root-go', writeGo('import', saved)])).toBe(1);
    expect(stderr).toContain('input-refused');
    expect(fs.existsSync(path.join(dir, 'b0.db'))).toBe(false);
    const backup = path.join(dir, 'b1.db');
    expect(await run(['import-saved', '--db', file, '--input', input, '--backup', backup,
      '--root-go', writeGo('import-saved', saved)])).toBe(0);
    expect(output()).toMatchObject({ code: 'saved-imported', orders: 2, valid: 2, held: [], invalid: [],
      written: { orders: 2, freshLists: 1, receipt: { newCaptures: 1, newOrders: 2, newMatches: 2, invalidated: 0 },
        gate: { passed: 2, failed: 0 } } });
    expect(fs.existsSync(backup)).toBe(true);
    expect([rows('amazon_captures'), rows('amazon_fresh_lines')]).toEqual([1, 4]);
    valueFree();
  });
  it('imports only the passing orders (exit 2), writing nothing of a held one', async () => {
    const saved = lonely();
    expect(await run(['import-saved', '--db', file, '--input', json('saved.json', saved), '--backup', path.join(dir, 'b2.db'),
      '--root-go', writeGo('import-saved', saved)])).toBe(2);
    expect(output()).toMatchObject({ code: 'saved-imported-partial', held: [{ index: 0, state: 'held', reason: 'no-candidate' }],
      written: { orders: 1, gate: { passed: 1, failed: 0 } } });
    expect(shown(saved.orders[0].orderId)).toEqual({ order: undefined, history: 0, match: undefined });
    expect([rows('amazon_captures'), rows('amazon_orders')]).toEqual([1, 1]);
    valueFree();
  });
  it('writes nothing (exit 1) when no order passes, keeping the backup', async () => {
    const saved = lonely();
    saved.orders[1].date = '2026-06-02';
    const backup = path.join(dir, 'b3.db');
    expect(await run(['import-saved', '--db', file, '--input', json('saved.json', saved), '--backup', backup,
      '--root-go', writeGo('import-saved', saved)])).toBe(1);
    expect(output()).toMatchObject({ code: 'saved-gate-refused', trial: { passed: 0, failed: 2 }, written: null });
    expect(fs.existsSync(backup)).toBe(true);
    expect(hasTable('amazon_fresh_lines')).toBe(false);
    expect(rows('amazon_captures')).toBe(0);
    valueFree();
  });
  it("holds a saved read that conflicts with the kit's order, leaving that order as it was, and imports its sibling", async () => {
    const setup = new SqliteStateRepo({ file });
    try { await importAmazonCapture(setup.internalGetDb(), syntheticCompleteCapture(), path.join(privateDir('kit'), 'kit.db')); }
    finally { setup.close(); }
    const kit = shown(KIT_ORDER);
    const saved = syntheticSavedOrders();
    saved.orders[0] = kitConflict('date');
    expect(await run(['import-saved', '--db', file, '--input', json('saved.json', saved), '--backup', path.join(dir, 'b4.db'),
      '--root-go', writeGo('import-saved', saved)])).toBe(2);
    expect(output()).toMatchObject({ code: 'saved-imported-partial', held: [{ index: 0, displayed: false }],
      written: { orders: 1, gate: { passed: 1 } } });
    expect(shown(KIT_ORDER)).toEqual(kit);
    valueFree();
  });
});
