import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { convertCostcoCapture } from '@finance-tracker/shared/retail-import-tool';
import { syntheticCostcoCapture, syntheticMembershipSpec } from '@finance-tracker/shared/retail-capture-fixtures';
import { retailDigest, type RetailImportPayload } from '@finance-tracker/shared/retail-import-payload';

import { ADMINISTRATORS_SID, SYSTEM_SID, type WindowsAcl } from '../e2e/windowsAcl.js';
import { digest } from '../services/amazon/policy.js';
import { RETAIL_POLICY_DIGEST, RETAIL_SCHEMA_DIGEST, retailSchemaState } from '../services/retail/index.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { NO_RESERVED, RETAIL_RESERVED_FIXTURES, importPayload, reservedValuesStored, retailReservedBase } from '../testing/retailDb.js';
import {
  SYNTHETIC_RETAIL_VALUES,
  heldRecord,
  onlineOrder,
  retailPayloadText,
  syntheticRetailPayload,
  valueFreeText,
  warehouseKey,
  warehouseReceipt,
} from '../testing/retailPayloads.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import type { OutputAccess } from './ownerOnlyOutput.js';
import { RETAIL_CLI_USAGE, runRetailCli, type RetailProbePoint } from './retail.js';

// Synthetic only: a database made by this build in a scratch directory, invented payloads, declarations and GO ids.

let template: string, root: string, dir: string, file: string, stdout: string, stderr: string, transcript: string;
let cases = 0;
const NOW = new Date('2031-03-01T12:00:00.000Z');
const BASE_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD', 'HOLDR_CONFIG'].includes(name)));
const DISPOSABLE = { ...BASE_ENV, HOLDR_CONFIG: 'none' };
/** A synthetic SID and a stand-in Windows ACL reader: owner-only unless a test adds an entry (as metals' CLI test does). */
const USER_SID = 'S-1-5-21-111-222-333-777';
const USERS_SID = 'S-1-5-32-545';
const standIn = (extra: WindowsAcl['aces'] = []): OutputAccess => ({
  platform: 'win32', currentUserSid: () => USER_SID,
  readAcls: (paths) => paths.map(() => {
    const aces: WindowsAcl['aces'] = [{ sid: USER_SID, rights: 0x1f01ff, type: 'Allow' }, { sid: SYSTEM_SID, rights: 0x1f01ff, type: 'Allow' },
      { sid: ADMINISTRATORS_SID, rights: 0x1f01ff, type: 'Allow' }, ...extra];
    return { owner: USER_SID, aces, aceTypes: aces.map((ace) => (ace.type === 'Allow' ? 'AccessAllowed' : 'AccessDenied')) };
  }),
});
const OWNER_ONLY = standIn();
/** Refused output places: a directory or file others can open, and one whose ACL can't be read. */
const SHARED = standIn([{ sid: USERS_SID, rights: 0x120089, type: 'Allow' }]);
const UNREADABLE: OutputAccess = { ...OWNER_ONLY, readAcls: () => { throw new Error('unreadable'); } };
/** Every directory owner-only, and a new file as `refused` reads it: only the new file's own check refuses. */
const newFileAccess = (refused: OutputAccess): OutputAccess => ({ ...OWNER_ONLY,
  readAcls: (paths) => paths.map((target) => (fs.statSync(target).isDirectory() ? OWNER_ONLY : refused).readAcls([target])[0]) });
const REFUSED = 'holdr-retail: input-refused HoldrRefusal\n';

const run = (args: string[], options: { env?: NodeJS.ProcessEnv; access?: OutputAccess; now?: () => Date; probe?: (point: RetailProbePoint) => void } = {}) => runRetailCli(args, {
  env: options.env ?? DISPOSABLE, now: options.now ?? (() => NOW), outputAccess: options.access ?? OWNER_ONLY, probe: options.probe,
  io: {
    stdout: { write: (s: string) => { stdout += s; transcript += s; } },
    stderr: { write: (s: string) => { stderr += s; transcript += s; } },
  },
});
const write = (name: string, value: unknown) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return target;
};
const at = (name: string) => path.join(dir, name);
/** Starts again in a new directory with a new copy of the template database, for a test that walks several cases. */
const fresh = () => {
  dir = path.join(root, `case-${++cases}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
  stdout = '';
};
const sha256 = (target: string) => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const output = () => {
  const value = JSON.parse(stdout) as Record<string, unknown>;
  stdout = '';
  return value;
};
const goFields = (command: string, patch: Record<string, unknown> = {}) => ({
  format: 'holdr.retail-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command, goId: randomBytes(16).toString('hex'),
  databaseRef: digest(path.resolve(file)), schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST, ...patch,
});
const go = (command: string, patch: Record<string, unknown> = {}) => write(`go-${randomBytes(6).toString('hex')}.json`, goFields(command, patch));
const newBackup = () => at(`backup-${randomBytes(4).toString('hex')}.db`);
/** The backups taken (their sidecars, which a read of a WAL-mode backup leaves, are not backups). */
const backups = () => fs.readdirSync(dir).filter((name) => /^backup-[0-9a-f]{8}\.db$/.test(name)).sort();
const payloadFile = (name: string, payload: RetailImportPayload) => write(name, retailPayloadText(payload));
const declarationFile = (name: string, folder = 'costco', patch: Record<string, unknown> = {}) => write(name, JSON.stringify({
  format: 'holdr.retail-membership-declaration', version: 1, merchant: 'costco', folder, owner: 'alex', label: 'Sample Household', ...patch,
}));
const opened = <T>(fn: (db: Database.Database) => T, target = file) => {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
};
const writable = <T>(fn: (db: Database.Database) => T) => {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    return fn(db);
  } finally {
    db.close();
  }
};
const count = (sql: string, target = file) => opened((db) => db.prepare(sql).pluck().get() as number, target);
const membershipRef = (folder = 'costco') => opened((db) => db.prepare('SELECT membership_ref FROM retail_memberships WHERE folder = ?').pluck().get(folder));
const install = () => run(['install', '--db', file, '--go', go('install'), '--backup', newBackup()]);
/** Imports a payload under its GO: a new folder's with its declaration, a registered one's by its ref. */
async function importFile(payload: string, options: { declaration?: string | null; membership?: unknown; goPatch?: Record<string, unknown> } = {}) {
  const declaration = options.declaration ?? null;
  const membership = options.membership ?? (declaration !== null ? { declarationSha256: sha256(declaration) } : { membershipRef: membershipRef() });
  const goFile = go('import', { inputSha256: sha256(payload), membership, ...options.goPatch });
  return run(['import', '--db', file, '--payload', payload, ...(declaration !== null ? ['--declaration', declaration] : []), '--go', goFile,
    '--backup', newBackup()]);
}
/** Installs, then imports receipt 1 and its changed re-read: receipt 1 quarantined, two imports. */
async function quarantinedReceipt(): Promise<void> {
  expect(await install()).toBe(0);
  expect(await importFile(payloadFile('first.json', syntheticRetailPayload({ capture: 'c' })), { declaration: declarationFile('declaration.json') })).toBe(0);
  expect(await importFile(payloadFile('second.json', syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] })))).toBe(0);
  stdout = '';
}
/** A review file for every quarantined receipt, built from `quarantine`'s listing as an operator would. */
async function reviewFileFromListing(decision: 'keep-quarantined' | 'canonical' = 'keep-quarantined') {
  stdout = '';
  expect(await run(['quarantine', '--db', file])).toBe(0);
  const listing = output() as { receipts: Array<{ receiptRef: string; evidenceDigest: string; canonicalVersion: string; versions: Array<{ versionRef: string }> }> };
  const decisions = listing.receipts.map((receipt) => ({
    receiptRef: receipt.receiptRef, evidenceDigest: receipt.evidenceDigest, decision, before: receipt.canonicalVersion,
    chosen: decision === 'canonical' ? receipt.versions.find((version) => version.versionRef !== receipt.canonicalVersion)!.versionRef : null,
  }));
  return { path: write(`review-${randomBytes(4).toString('hex')}.json`, { format: 'holdr.retail-receipt-review', version: 1, decisions }),
    receiptRefs: decisions.map((entry) => entry.receiptRef) };
}

beforeAll(async () => {
  template = await makeScratchDir('retail-cli-template-');
  const repo = new SqliteStateRepo({ file: path.join(template, 'finance.db') });
  repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '0007', currency: 'USD' });
  repo.close();
  const db = new Database(path.join(template, 'finance.db'));
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = ''; transcript = '';
  root = dir = await makeScratchDir('retail-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(root); });

describe('holdr-retail plan, install and declare-membership', () => {
  it('prints its usage, and plans read-only: schema, digests, counts and the database reference only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(RETAIL_CLI_USAGE);
    // The shared rule's prefixes as an operator reads them: a lone backslash in the usage's template literal would vanish.
    expect(stdout).toContain(String.raw`nor may the path start \\?\, \\.\ or \??\ (the one shared rule)`);
    stdout = '';
    const before = fs.readFileSync(file);
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    expect(await run(['plan', '--db', file, '--payload', payload, '--declaration', declarationFile('declaration.json')])).toBe(0);
    expect(output()).toEqual({ code: 'retail-planned', schema: 'absent', schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST,
      databaseRef: digest(path.resolve(file)), objects: expect.objectContaining({ matching: 0, differing: 0, unexpected: 0 }),
      input: { inputSha256: sha256(payload) }, import: { code: 'retail-not-installed' } });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(await install()).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-installed', purpose: 'copy-rehearsal', schemaDigest: RETAIL_SCHEMA_DIGEST,
      objects: { differing: 0, missing: 0, unexpected: 0 } });
    expect(opened(retailSchemaState)).toBe('present');
    const [first] = backups();
    expect(opened(retailSchemaState, at(first))).toBe('absent');
    if (process.platform !== 'win32') expect(fs.statSync(at(first)).mode & 0o777).toBe(0o600);
    expect(await install()).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-already-installed' });
    expect(backups()).toEqual([first]);
    expect(await run(['plan', '--db', file, '--payload', payload, '--declaration', declarationFile('declaration-2.json')])).toBe(0);
    expect(output()).toMatchObject({ schema: 'present', import: { alreadyImported: false, membership: { kind: 'register' }, receipts: 1,
      outcomes: { new: 1 }, held: { 'no-key': 0, pending: 0, quarantining: 0 }, possibleOverlap: 0, cardLast4sUnbound: 1 } });
    expect(await run(['plan', '--db', file, '--payload', payload])).toBe(0);
    expect(output()).toMatchObject({ import: { code: 'retail-membership-undeclared' } });
  });

  it('checks a membership declaration and prints its digest, folder and owner, never its label', async () => {
    const declaration = declarationFile('declaration.json', 'costco-3', { owner: 'joint' });
    expect(await run(['declare-membership', '--declaration', declaration])).toBe(0);
    expect(output()).toEqual({ code: 'retail-declaration-valid', declarationSha256: sha256(declaration), folder: 'costco-3', owner: 'joint' });
    for (const patch of [{ owner: 'guest' }, { label: 'Card 12345' }, { label: ' Padded' }, { folder: 'costco-0' }, { merchant: 'walmart' },
      { version: '1' }, { extra: true }]) {
      expect(await run(['declare-membership', '--declaration', declarationFile(`bad-${randomBytes(3).toString('hex')}.json`, 'costco', patch)])).toBe(1);
      expect(output()).toEqual({ code: 'retail-declaration-invalid' });
    }
  });

  it('plans a conflict (exit 1) with its counts, and never installs or reads over it', async () => {
    writable((db) => db.exec('CREATE TABLE retail_extra (id TEXT)'));
    expect(await run(['plan', '--db', file])).toBe(1);
    expect(output()).toMatchObject({ code: 'retail-conflict', schema: 'conflict', objects: { unexpected: 1 } });
    expect(await install()).toBe(1);
    expect(output()).toEqual({ code: 'retail-conflict' });
    for (const command of [['quarantine', '--db', file], ['report', '--db', file]]) {
      expect(await run(command)).toBe(1);
      expect(output()).toEqual({ code: 'retail-conflict' });
    }
    expect(backups()).toEqual([]);
  });
});

describe('holdr-retail GO (plan §8.4)', () => {
  it('refuses a GO that is not exactly a Root GO for this command, database, schema and policy, before any backup', async () => {
    const before = fs.readFileSync(file);
    const cases: Array<[string, string]> = [
      [go('install', { format: 'holdr.metals-go' }), 'retail-go-invalid'], [go('install', { version: '1' }), 'retail-go-invalid'],
      [go('install', { version: 2 }), 'retail-go-invalid'], [go('install', { authority: 'Alex' }), 'retail-go-invalid'],
      [go('install', { decision: 'HOLD' }), 'retail-go-invalid'], [go('import'), 'retail-go-invalid'],
      [go('install', { command: 'import' }), 'retail-go-invalid'], [go('install', { databaseRef: digest('/elsewhere/finance.db') }), 'retail-go-invalid'],
      [go('install', { schemaDigest: 'a'.repeat(64) }), 'retail-go-invalid'], [go('install', { policyDigest: 'a'.repeat(64) }), 'retail-go-invalid'],
      [go('install', { goId: 'G'.repeat(32) }), 'retail-go-id-invalid'], [go('install', { goId: 1 }), 'retail-go-id-invalid'],
      [go('install', { purpose: 'production-import' }), 'retail-purpose-invalid'], [go('install', { purpose: 'preview' }), 'retail-purpose-invalid'],
      [write('extra.json', { ...goFields('install'), note: 'x' }), 'retail-go-invalid'],
      [write('missing.json', Object.fromEntries(Object.entries(goFields('install')).filter(([key]) => key !== 'policyDigest'))), 'retail-go-invalid'],
      [write('not-json.json', '{'), 'retail-go-invalid'],
      [write('large.json', JSON.stringify({ ...goFields('install'), padding: 'x'.repeat(64 * 1024) })), 'retail-go-invalid'],
    ];
    for (const [goFile, code] of cases) {
      expect(await run(['install', '--db', file, '--go', goFile, '--backup', newBackup()])).toBe(1);
      expect(output(), goFile).toEqual({ code });
    }
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // Purposes are per command; options are absolute paths, each once.
    expect(await install()).toBe(0);
    stdout = '';
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    expect(await importFile(payload, { declaration, goPatch: { purpose: 'production-install' } })).toBe(1);
    expect(output()).toEqual({ code: 'retail-purpose-invalid' });
    expect(await run(['install', '--db', 'finance.db', '--go', go('install'), '--backup', newBackup()])).toBe(1);
    expect(output()).toEqual({ code: 'retail-path-not-absolute' });
    for (const args of [['install', '--db', file], ['install', '--db', file, '--db', file, '--go', go('install'), '--backup', newBackup()], ['nonsense'],
      ['bindings', 'approve', '--db', file]]) {
      stderr = '';
      expect(await run(args)).toBe(1);
      expect(stderr).toBe(REFUSED);
    }
  });

  it('pins an import\'s GO to the payload and its membership, and a review\'s to the file and its receipts', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    const imports = () => count('SELECT count(*) FROM retail_imports');
    const cases: Array<[Parameters<typeof importFile>[1], string]> = [
      [{ declaration, goPatch: { inputSha256: 'a'.repeat(64) } }, 'retail-input-mismatch'],
      [{ declaration, membership: { declarationSha256: 'b'.repeat(64) } }, 'retail-input-mismatch'],
      [{ declaration, membership: { declarationSha256: sha256(declaration), extra: 1 } }, 'retail-go-invalid'],
      [{ declaration, membership: { membershipRef: `rtl-mbr-${'a'.repeat(32)}` } }, 'retail-membership-unknown'],
      [{ declaration: null, membership: { declarationSha256: sha256(declaration) } }, 'retail-membership-undeclared'],
    ];
    for (const [options, code] of cases) {
      expect(await importFile(payload, options)).toBe(1);
      expect(output()).toEqual(expect.objectContaining({ code }));
    }
    expect(imports()).toBe(0);
    expect(backups()).toHaveLength(1);
    expect(await importFile(payload, { declaration })).toBe(0);
    stdout = '';
    expect(await importFile(payloadFile('second.json', syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] })))).toBe(0);
    stdout = '';
    const review = await reviewFileFromListing();
    const reviewRun = (patch: Record<string, unknown>) => run(['review-receipt', '--db', file, '--review', review.path, '--go',
      go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs, ...patch }), '--backup', newBackup()]);
    for (const patch of [{ reviewSha256: 'a'.repeat(64) }, { receiptRefs: [] }, { receiptRefs: [`rcp-${'a'.repeat(32)}`] }]) {
      expect(await reviewRun(patch)).toBe(1);
      expect(output()).toEqual({ code: 'retail-input-mismatch' });
    }
    expect(await reviewRun({ purpose: 'production-import' })).toBe(1);
    expect(output()).toEqual({ code: 'retail-purpose-invalid' });
    expect(await reviewRun({})).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-reviewed', reviewSha256: sha256(review.path), decisions: [{ decision: 'keep-quarantined' }] });
    const taken = backups();
    expect(await reviewRun({})).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-already-reviewed' });
    expect(backups()).toEqual(taken);
  });
});

describe('holdr-retail import: the fenced write (plan §2)', () => {
  it('imports after a backup; the same payload again writes nothing; nothing restores the backup after a commit', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const installed = backups();
    const payload = payloadFile('payload.json', syntheticRetailPayload({ receipts: [warehouseReceipt(1), onlineOrder(2)] }));
    const declaration = declarationFile('declaration.json');
    expect(await importFile(payload, { declaration })).toBe(0);
    const receipt = output();
    expect(receipt).toMatchObject({ code: 'retail-imported', purpose: 'copy-rehearsal', inputSha256: sha256(payload), importSeq: 1,
      membership: { kind: 'registered', membershipRef: membershipRef() }, receipts: 2, outcomes: { new: 2 } });
    const taken = backups();
    const [importBackup] = taken.filter((name) => !installed.includes(name));
    expect(taken).toHaveLength(2);
    expect(opened((db) => db.pragma('integrity_check', { simple: true }), at(importBackup))).toBe('ok');
    expect(opened(retailSchemaState, at(importBackup))).toBe('present');
    expect(count('SELECT count(*) FROM retail_imports', at(importBackup))).toBe(0);
    expect(count('SELECT count(*) FROM retail_imports')).toBe(1);
    expect(await importFile(payload)).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-already-imported', inputSha256: sha256(payload), importId: receipt.importId });
    expect(backups()).toEqual(taken);
    // After the command: the write stays, the backup is untouched.
    expect(count('SELECT count(*) FROM retail_receipts')).toBe(2);
    expect(count('SELECT count(*) FROM retail_imports', at(importBackup))).toBe(0);
  });

  it('refuses every input before the database is opened, and a payload the tables could not hold before any backup', async () => {
    const missing = at('absent.db');
    const loose = write('loose.json', JSON.stringify(syntheticRetailPayload()));
    const invalid = write('invalid.json', retailPayloadText({ ...syntheticRetailPayload(), version: 2 } as unknown as RetailImportPayload));
    const unstorable = payloadFile('unstorable.json', syntheticRetailPayload({ capturedAt: '2031-02-30T04:05:06Z' }));
    const large = at('large.json');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 64 * 1024 * 1024 + 1);
    const cases: Array<[string, Record<string, unknown>]> = [
      [loose, { code: 'retail-payload-not-canonical' }],
      [invalid, { code: 'retail-payload-invalid', issues: [{ path: '$.version', message: 'is not the expected value' }] }],
      [unstorable, { code: 'retail-payload-unstorable', paths: ['$.source.capturedAt'] }],
      [large, { code: 'retail-payload-too-large' }],
    ];
    for (const [payload, refused] of cases) {
      expect(await run(['import', '--db', missing, '--payload', payload, '--go', go('import'), '--backup', newBackup()])).toBe(1);
      expect(output()).toEqual(refused);
      expect(await run(['plan', '--db', missing, '--payload', payload])).toBe(1);
      expect(output()).toEqual(refused);
    }
    expect(fs.existsSync(missing)).toBe(false);
    expect(backups()).toEqual([]);
  });

  it('takes no lease where none can be held, and writes nothing then', async () => {
    const control = path.join(dir, 'control');
    fs.mkdirSync(control, { mode: 0o700 });
    const before = fs.readFileSync(file);
    expect(await run(['install', '--db', file, '--go', go('install'), '--backup', newBackup()], { env: { ...BASE_ENV, HOLDR_CONTROL_DIR: control } })).toBe(1);
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // Read-only commands without the protocol run only on a disposable stack.
    for (const command of [['plan', '--db', file], ['quarantine', '--db', file], ['report', '--db', file],
      ['bindings', 'propose', '--db', file, '--out', at('proposal.json')]]) {
      stdout = '';
      expect(await run(command, { env: BASE_ENV })).toBe(1);
      expect(output()).toEqual({ code: 'retail-no-shared-lease' });
    }
    expect(fs.existsSync(at('proposal.json'))).toBe(false);
  });

  it('keeps the code of a refusal met inside the backed-up transaction, writing nothing: the plan changed, or a bad clock', async () => {
    expect(await install()).toBe(0);
    expect(await importFile(payloadFile('first.json', syntheticRetailPayload({ capture: 'c' })), { declaration: declarationFile('declaration.json') })).toBe(0);
    stdout = '';
    const changed = payloadFile('changed.json', syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] }));
    const changedGo = () => go('import', { inputSha256: sha256(changed), membership: { membershipRef: membershipRef() } });
    // Between the preflight and the write, another sighting of the same receipt lands, as a second operator's import would.
    let landed = false;
    const landing = () => {
      if (!landed) {
        landed = true;
        const db = new Database(file, { fileMustExist: true });
        try {
          db.pragma('foreign_keys = ON');
          importPayload(db, syntheticRetailPayload({ capture: 'e' }));
        } finally {
          db.close();
        }
      }
      return NOW;
    };
    const versions = count('SELECT count(*) FROM retail_receipt_versions');
    const taken = backups().length;
    expect(await run(['import', '--db', file, '--payload', changed, '--go', changedGo(), '--backup', newBackup()], { now: landing })).toBe(1);
    expect(output()).toEqual({ code: 'retail-plan-changed' });
    // The backup was taken before the write refused, and nothing restores it; the landing import alone was written.
    expect(backups()).toHaveLength(taken + 1);
    expect(count('SELECT count(*) FROM retail_receipt_versions')).toBe(versions);
    expect(count('SELECT count(*) FROM retail_imports')).toBe(2);
    expect(await run(['import', '--db', file, '--payload', changed, '--go', changedGo(), '--backup', newBackup()],
      { now: () => new Date('+010000-01-01T00:00:00.000Z') })).toBe(1);
    expect(output()).toEqual({ code: 'retail-time-invalid' });
    expect(count('SELECT count(*) FROM retail_receipt_versions')).toBe(versions);
    expect(count('SELECT count(*) FROM retail_imports')).toBe(2);
  });
});

describe('holdr-retail import: a receipt\'s channel is its identity (D-PR2-C6)', () => {
  it('refuses a stored receipt sighted under another channel before any backup, in either arrival order', async () => {
    for (const [first, second] of [['warehouse', 'gas'], ['gas', 'warehouse']] as const) {
      fresh();
      expect(await install()).toBe(0);
      const declaration = declarationFile('declaration.json');
      const stored = payloadFile('first.json', syntheticRetailPayload({ capture: 'c', receipts: [{ ...warehouseReceipt(1), channel: first }] }));
      expect(await importFile(stored, { declaration }), first).toBe(0);
      stdout = '';
      const before = fs.readFileSync(file);
      const taken = backups();
      const incoming = payloadFile('second.json', syntheticRetailPayload({ capture: 'd', receipts: [{ ...warehouseReceipt(1), channel: second }] }));
      expect(await importFile(incoming), `${first} then ${second}`).toBe(1);
      expect(output(), `${first} then ${second}`).toEqual({ code: 'retail-receipt-conflict', field: 'channel', receiptRef: expect.stringMatching(/^rcp-[a-p]{32}$/) });
      expect(backups(), `${first} then ${second}`).toEqual(taken);
      expect(fs.readFileSync(file).equals(before), `${first} then ${second}`).toBe(true);
    }
  });
});

describe('holdr-retail writes: one fence from before the backup to the commit (ROOT 11/09, D-PR2-C3)', () => {
  it('holds the write lock from before each backup until its commit: no other connection commits a write in between', async () => {
    writable((db) => db.exec('CREATE TABLE fence_probe (id INTEGER PRIMARY KEY)'));
    const other = new Database(file, { timeout: 0 });
    try {
      const attempt = () => {
        try {
          other.prepare('INSERT INTO fence_probe DEFAULT VALUES').run();
          return 'committed';
        } catch (error) {
          // Only SQLite's busy refusal is an answer here; anything else fails the test as itself (addendum 3(e)).
          if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY')) return 'busy';
          throw error;
        }
      };
      const first = payloadFile('first.json', syntheticRetailPayload({ capture: 'c' }));
      const declaration = declarationFile('declaration.json');
      let review = { path: '', receiptRefs: [] as string[] };
      // Each write: what it needs first, its command, its receipt's code, and what it writes, with that before and after.
      const writes: Array<[string, () => Promise<void>, () => string[], string, (target?: string) => unknown, unknown, unknown]> = [
        ['install', async () => {}, () => ['install', '--db', file, '--go', go('install'), '--backup', newBackup()], 'retail-installed',
          (target) => opened(retailSchemaState, target), 'absent', 'present'],
        ['import', async () => {}, () => ['import', '--db', file, '--payload', first, '--declaration', declaration, '--go',
          go('import', { inputSha256: sha256(first), membership: { declarationSha256: sha256(declaration) } }), '--backup', newBackup()],
        'retail-imported', (target) => count('SELECT count(*) FROM retail_imports', target), 0, 1],
        ['review-receipt', async () => {
          expect(await importFile(payloadFile('second.json', syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] })))).toBe(0);
          review = await reviewFileFromListing();
        }, () => ['review-receipt', '--db', file, '--review', review.path, '--go',
          go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs }), '--backup', newBackup()],
        'retail-reviewed', (target) => count('SELECT count(*) FROM retail_receipt_reviews', target), 0, 1],
      ];
      for (const [what, setup, args, code, written, before, after] of writes) {
        await setup();
        const seen: Array<[RetailProbePoint, string]> = [];
        const taken = backups();
        const rows = count('SELECT count(*) FROM fence_probe');
        expect(await run(args(), { probe: (point) => { seen.push([point, attempt()]); } }), what).toBe(0);
        expect(output(), what).toMatchObject({ code });
        expect(seen, what).toEqual([['fenced', 'busy'], ['backed-up', 'busy'], ['written', 'busy']]);
        // The other writer waited out the fence, not lost: it commits once the retail write has.
        expect(attempt(), what).toBe('committed');
        // The backup is the state the fence began from: neither this write nor any of the other connection's.
        const added = backups().filter((name) => !taken.includes(name));
        expect(added, what).toHaveLength(1);
        expect(count('SELECT count(*) FROM fence_probe', at(added[0])), what).toBe(rows);
        expect(opened((db) => db.pragma('integrity_check', { simple: true }), at(added[0])), what).toBe('ok');
        expect(written(at(added[0])), what).toBe(before);
        expect(written(), what).toBe(after);
      }
    } finally {
      other.close();
    }
  });

  it('backs up only into a directory and a new file only the owner can open, refused before a byte is copied (D-PR2-C2)', async () => {
    // A refused directory stops the command before the database is opened; a refused new file, inside the fence, before
    // the backup: it is removed while still empty, and the transaction rolls back.
    const cases: Array<[string, OutputAccess, string, RetailProbePoint[]]> = [
      ['a shared directory', SHARED, 'retail-output-not-owner-only', []],
      ['an unreadable directory', UNREADABLE, 'retail-output-uncheckable', []],
      ['a shared new file', newFileAccess(SHARED), 'retail-output-not-owner-only', ['fenced']],
      ['an unreadable new file', newFileAccess(UNREADABLE), 'retail-output-uncheckable', ['fenced']],
    ];
    const first = payloadFile('first.json', syntheticRetailPayload({ capture: 'c' }));
    const declaration = declarationFile('declaration.json');
    let review = { path: '', receiptRefs: [] as string[] };
    // Each write: what it needs first, its command, and what it would write.
    const writes: Array<[string, () => Promise<void>, () => string[], () => unknown]> = [
      ['install', async () => {}, () => ['install', '--db', file, '--go', go('install'), '--backup', newBackup()], () => opened(retailSchemaState)],
      ['import', async () => { expect(await install()).toBe(0); }, () => ['import', '--db', file, '--payload', first, '--declaration', declaration,
        '--go', go('import', { inputSha256: sha256(first), membership: { declarationSha256: sha256(declaration) } }), '--backup', newBackup()],
      () => count('SELECT count(*) FROM retail_imports')],
      ['review-receipt', async () => {
        expect(await importFile(first, { declaration })).toBe(0);
        expect(await importFile(payloadFile('second.json', syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] })))).toBe(0);
        review = await reviewFileFromListing();
      }, () => ['review-receipt', '--db', file, '--review', review.path, '--go',
        go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs }), '--backup', newBackup()],
      () => count('SELECT count(*) FROM retail_receipt_reviews')],
    ];
    for (const [what, setup, args, written] of writes) {
      await setup();
      stdout = '';
      for (const [place, access, code, points] of cases) {
        const label = `${what}: ${place}`;
        const taken = backups();
        const before = written();
        const seen: RetailProbePoint[] = [];
        expect(await run(args(), { access, probe: (point) => { seen.push(point); } }), label).toBe(1);
        expect(output(), label).toEqual({ code });
        expect(seen, label).toEqual(points);
        expect(backups(), label).toEqual(taken);
        expect(written(), label).toEqual(before);
      }
    }
  });

  it('never backs up or clones onto one of the database\'s own SQLite files, whatever its directory is called (D-PR2-C5)', async () => {
    fresh();
    await quarantinedReceipt();
    const review = await reviewFileFromListing();
    const first = at('first.json');
    const member = membershipRef();
    // A read leaves the -wal and -shm of a WAL-mode database; a writer that checkpoints removes them as it closes, the
    // last connection, so no name is taken.
    writable((db) => db.pragma('wal_checkpoint(TRUNCATE)'));
    const suffixes = ['', '-wal', '-shm', '-journal'];
    expect(suffixes.filter((suffix) => fs.existsSync(`${file}${suffix}`))).toEqual(['']);
    // Another name for the database's directory: a junction on Windows, a symbolic link elsewhere.
    const alias = path.join(root, 'alias');
    fs.symlinkSync(dir, alias, 'junction');
    try {
      const commands: Array<[string, (place: string) => string[]]> = [
        ['install', (place) => ['install', '--db', file, '--go', go('install'), '--backup', place]],
        ['import', (place) => ['import', '--db', file, '--payload', first, '--go',
          go('import', { inputSha256: sha256(first), membership: { membershipRef: member } }), '--backup', place]],
        ['review-receipt', (place) => ['review-receipt', '--db', file, '--review', review.path, '--go',
          go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs }), '--backup', place]],
        ['preview', (place) => ['preview', '--db', file, '--clone', place, '--payload', first]],
      ];
      const source = fs.readFileSync(file);
      const taken = backups();
      for (const [what, args] of commands) {
        for (const suffix of suffixes) {
          const label = `${what}: finance.db${suffix}`;
          stdout = '';
          stderr = '';
          const seen: RetailProbePoint[] = [];
          expect(await run(args(path.join(alias, `${path.basename(file)}${suffix}`)), { probe: (point) => { seen.push(point); } }), label).toBe(1);
          // The database's own name is taken; a sidecar's name, resolved, is the database's own: refused before it opens.
          if (suffix === '') expect(output(), label).toEqual({ code: 'retail-output-exists' });
          else if (what === 'preview') expect(output(), label).toEqual({ code: 'retail-clone-is-source' });
          else expect([stdout, stderr], label).toEqual(['', REFUSED]);
          expect(seen, label).toEqual([]);
          expect(suffixes.filter((name) => fs.existsSync(`${file}${name}`)), label).toEqual(['']);
        }
      }
      expect(backups()).toEqual(taken);
      expect(fs.readFileSync(file).equals(source)).toBe(true);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it('refuses an output name another program reads as another file, or one SQLite keeps beside a database, before anything is created (D-PR2-C7, ROOT\'s C4 ruling)', async () => {
    fresh();
    await quarantinedReceipt();
    const review = await reviewFileFromListing();
    const first = at('first.json');
    const member = membershipRef();
    writable((db) => db.pragma('wal_checkpoint(TRUNCATE)'));
    // An existing SQLite file, which SQLite and every other Win32 caller open for `old.db.`.
    const old = at('old.db');
    fs.copyFileSync(file, old);
    // A trailing dot or space (the source's own name so read, and an existing file's), a device's name bare or with an
    // extension (a superscript COM or LPT one too), a stream of the source, and names SQLite keeps beside a database, in
    // any case.
    const names = [`${file}.`, `${file} `, `${old}.`, at('NUL'), at('nul.db'), at('COM1.db'), at('com\u00b9'), at('LPT\u00b3.db'), `${file}:s`,
      at('other.db-wal'), at('OTHER.DB-SHM'), at('other.db-Journal')];
    const commands: Array<[string, (place: string) => string[]]> = [
      ['install', (place) => ['install', '--db', file, '--go', go('install'), '--backup', place]],
      ['import', (place) => ['import', '--db', file, '--payload', first, '--go',
        go('import', { inputSha256: sha256(first), membership: { membershipRef: member } }), '--backup', place]],
      ['review-receipt', (place) => ['review-receipt', '--db', file, '--review', review.path, '--go',
        go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs }), '--backup', place]],
      ['preview', (place) => ['preview', '--db', file, '--clone', place, '--payload', first]],
      ['bindings propose', (place) => ['bindings', 'propose', '--db', file, '--out', place]],
    ];
    const source = fs.readFileSync(file);
    const oldBytes = fs.readFileSync(old);
    for (const [what, args] of commands) {
      for (const name of names) {
        const label = `${what}: ${JSON.stringify(path.basename(name))}`;
        const argv = args(name);
        const listing = fs.readdirSync(dir).sort();
        stdout = '';
        stderr = '';
        const seen: RetailProbePoint[] = [];
        expect(await run(argv, { probe: (point) => { seen.push(point); } }), label).toBe(1);
        expect([output(), stderr], label).toEqual([{ code: 'retail-output-name-refused' }, '']);
        // Refused before anything is created: no probe point reached, no new name, and nothing at the name itself.
        expect(seen, label).toEqual([]);
        expect(fs.readdirSync(dir).sort(), label).toEqual(listing);
        expect(fs.existsSync(name), label).toBe(false);
      }
    }
    expect(fs.readFileSync(file).equals(source)).toBe(true);
    expect(fs.readFileSync(old).equals(oldBytes)).toBe(true);
  });

  it('refuses an output in a folder Windows reads as another, named so or behind a plain-named link, before anything is created (D-PR2-C7, ROOT\'s ancestor ruling)', async () => {
    fresh();
    await quarantinedReceipt();
    const review = await reviewFileFromListing();
    const first = at('first.json');
    const member = membershipRef();
    const old = at('old.db');
    fs.copyFileSync(file, old);
    // Folders Node makes as named beside the database's own: Win32 reads `case-N.\…` as `case-N\…`, so a backup or clone
    // there would land on the source or on old.db; the shared rule refuses the spaced one alike. And a link with a
    // plain name to each: its folder resolves to the aliased one.
    const aliased = [`${dir}.`, `${dir} `];
    const links = aliased.map((_, index) => path.join(root, `plain-${cases}-${index}`));
    try {
      for (const [index, folder] of aliased.entries()) {
        fs.mkdirSync(folder, { mode: 0o700 });
        fs.mkdirSync(path.join(folder, 'deeper'), { mode: 0o700 });
        fs.symlinkSync(folder, links[index], 'junction');
        expect(path.basename(fs.realpathSync.native(links[index])), links[index]).toBe(path.basename(folder));
      }
      if (process.platform === 'win32') {
        // The hazard is real: SQLite opens the source through the dotted folder, and through the link's resolved folder.
        const throughDotted = path.join(fs.realpathSync.native(links[0]), path.basename(file));
        expect(opened((db) => db.prepare('SELECT count(*) FROM retail_imports').pluck().get(), throughDotted)).toBe(2);
      }
      writable((db) => db.pragma('wal_checkpoint(TRUNCATE)'));
      const places = [
        ...aliased.flatMap((folder) => [path.join(folder, 'finance.db'), path.join(folder, 'old.db'), path.join(folder, 'deeper', 'new.db')]),
        ...links.flatMap((link) => [path.join(link, 'finance.db'), path.join(link, 'old.db')]),
      ];
      const commands: Array<[string, (place: string) => string[]]> = [
        ['install', (place) => ['install', '--db', file, '--go', go('install'), '--backup', place]],
        ['import', (place) => ['import', '--db', file, '--payload', first, '--go',
          go('import', { inputSha256: sha256(first), membership: { membershipRef: member } }), '--backup', place]],
        ['review-receipt', (place) => ['review-receipt', '--db', file, '--review', review.path, '--go',
          go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs }), '--backup', place]],
        ['preview', (place) => ['preview', '--db', file, '--clone', place, '--payload', first]],
        ['bindings propose', (place) => ['bindings', 'propose', '--db', file, '--out', place]],
      ];
      const source = fs.readFileSync(file);
      const oldBytes = fs.readFileSync(old);
      const listings = () => [dir, ...aliased, ...aliased.map((folder) => path.join(folder, 'deeper'))].map((folder) => fs.readdirSync(folder).sort());
      for (const [what, args] of commands) {
        for (const place of places) {
          const label = `${what}: ${JSON.stringify(path.relative(root, place))}`;
          const argv = args(place);
          const before = listings();
          stdout = '';
          stderr = '';
          const seen: RetailProbePoint[] = [];
          expect(await run(argv, { probe: (point) => { seen.push(point); } }), label).toBe(1);
          expect([output(), stderr], label).toEqual([{ code: 'retail-output-name-refused' }, '']);
          // Refused before anything is created: no probe point reached, and no new name in any of the folders.
          expect(seen, label).toEqual([]);
          expect(listings(), label).toEqual(before);
        }
      }
      expect(fs.readFileSync(file).equals(source)).toBe(true);
      expect(fs.readFileSync(old).equals(oldBytes)).toBe(true);
    } finally {
      for (const link of links) if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link);
      for (const folder of aliased) fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('holdr-retail preview: the clone-only exception (plan §8.2, Q-P1)', () => {
  const sidecars = (target: string) => [target, `${target}-wal`, `${target}-shm`, `${target}-journal`];
  const identity = (target: string) => {
    const stat = fs.statSync(target);
    return { bytes: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), size: stat.size, mtime: stat.mtimeMs, ino: stat.ino };
  };

  it('installs and imports on its own new clone only, under no GO, and claims no activation', async () => {
    const source = identity(file);
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const clone = at('clone.db');
    expect(await run(['preview', '--db', file, '--clone', clone, '--payload', payload, '--declaration', declarationFile('declaration.json')])).toBe(0);
    const previewed = output();
    expect(previewed).toEqual({ code: 'retail-previewed', source: { schema: 'absent' }, install: { installed: true },
      import: expect.objectContaining({ code: 'retail-imported', importSeq: 1, receipts: 1, outcomes: expect.objectContaining({ new: 1 }) }),
      activation: 'none' });
    // Its placeholders for the names SQLite keeps beside the clone are gone: SQLite removed them, and the clone is closed.
    for (const name of sidecars(clone).slice(1)) expect(fs.existsSync(name), name).toBe(false);
    expect(identity(file)).toEqual(source);
    expect(opened(retailSchemaState)).toBe('absent');
    expect(opened((db) => db.prepare('SELECT purpose, go_id AS goId FROM retail_imports').all(), clone)).toEqual([{ purpose: 'preview', goId: null }]);
    expect(opened((db) => db.prepare('SELECT kind, purpose, go_id AS goId FROM retail_audit ORDER BY seq').all(), clone))
      .toEqual([{ kind: 'install', purpose: 'preview', goId: null }, { kind: 'import', purpose: 'preview', goId: null }]);
    expect(opened(reservedValuesStored, clone)).toEqual(NO_RESERVED);
    expect(opened((db) => db.prepare('SELECT count(*) FROM card_accounts').pluck().get(), clone)).toBe(1);
  });

  it('refuses an unsafe destination before any byte is copied, and touches nothing that was there', async () => {
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    const source = identity(file);
    const existing = write('existing.db', 'x');
    const journal = write('journalled.db-journal', 'kept');
    const cases: Array<[string, Record<string, unknown> | null, OutputAccess]> = [
      ['clone.db', { code: 'retail-path-not-absolute' }, OWNER_ONLY],
      [existing, { code: 'retail-output-exists' }, OWNER_ONLY],
      [at('journalled.db'), { code: 'retail-output-exists' }, OWNER_ONLY],
      [file, { code: 'retail-output-exists' }, OWNER_ONLY],
      [`${file}-wal`, { code: 'retail-clone-is-source' }, OWNER_ONLY],
      [`${file}-journal`, { code: 'retail-clone-is-source' }, OWNER_ONLY],
      [at('shared.db'), { code: 'retail-output-not-owner-only' }, SHARED],
      [at('uncheckable.db'), { code: 'retail-output-uncheckable' }, UNREADABLE],
      // The directory owner-only, the new clone not (D-PR2-C2): refused before a byte of the source is copied, and
      // removed while still empty.
      [at('shared-file.db'), { code: 'retail-output-not-owner-only' }, newFileAccess(SHARED)],
      [at('unreadable-file.db'), { code: 'retail-output-uncheckable' }, newFileAccess(UNREADABLE)],
    ];
    for (const [clone, refused, access] of cases) {
      expect(await run(['preview', '--db', file, '--clone', clone, '--payload', payload, '--declaration', declaration], { access })).toBe(1);
      expect(output(), clone).toEqual(refused);
    }
    expect(fs.readFileSync(journal, 'utf8')).toBe('kept');
    expect(fs.readFileSync(existing, 'utf8')).toBe('x');
    for (const name of ['clone.db', 'shared.db', 'uncheckable.db', 'journalled.db']) expect(fs.existsSync(at(name)), name).toBe(false);
    for (const name of [...sidecars(at('shared-file.db')), ...sidecars(at('unreadable-file.db'))]) expect(fs.existsSync(name), name).toBe(false);
    expect(identity(file)).toEqual(source);
    // No lease protocol outside a disposable stack.
    expect(await run(['preview', '--db', file, '--clone', at('clone.db'), '--payload', payload, '--declaration', declaration], { env: BASE_ENV })).toBe(1);
    expect(output()).toEqual({ code: 'retail-no-shared-lease' });
    expect(fs.existsSync(at('clone.db'))).toBe(false);
  });

  it('removes only what it created when the clone\'s import fails, and leaves the source as it was', async () => {
    expect(await install()).toBe(0);
    expect(await importFile(payloadFile('first.json', syntheticRetailPayload({ capture: 'c' })), { declaration: declarationFile('declaration.json') })).toBe(0);
    stdout = '';
    const source = identity(file);
    const other = write('other.db-shm', 'kept');
    const conflicting = payloadFile('conflicting.json', syntheticRetailPayload({ capture: 'd', memberSinceYear: '1999' }));
    const clone = at('clone.db');
    expect(await run(['preview', '--db', file, '--clone', clone, '--payload', conflicting])).toBe(1);
    expect(output()).toEqual({ code: 'retail-membership-conflict', field: 'member-since-year' });
    for (const name of sidecars(clone)) expect(fs.existsSync(name), name).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('kept');
    expect(identity(file)).toEqual(source);
  });

  it('creates the clone and every name SQLite keeps beside it exclusively, and removes only what it created (D-PR2-C4)', async () => {
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    const source = identity(file);
    const clone = at('clone.db');
    const args = ['preview', '--db', file, '--clone', clone, '--payload', payload, '--declaration', declaration];
    // A competing file lands at one of the names once the destination is checked: the preview refuses, the competitor
    // keeps its content, and the names the preview had created are gone again.
    for (const name of sidecars(clone)) {
      const compete = (point: RetailProbePoint) => {
        if (point === 'clone-checked') fs.writeFileSync(name, 'competitor');
      };
      expect(await run(args, { probe: compete }), name).toBe(1);
      expect(output(), name).toEqual({ code: 'retail-output-exists' });
      expect(fs.readFileSync(name, 'utf8'), name).toBe('competitor');
      expect(sidecars(clone).filter((other) => fs.existsSync(other)), name).toEqual([name]);
      fs.rmSync(name);
    }
    expect(identity(file)).toEqual(source);
    // A file put in place of one the preview created, before a later refusal (the source's reserved-value STOP): the
    // cleanup removes the preview's own files, never the one put in its place.
    await quarantinedReceipt();
    writable((db) => { RETAIL_RESERVED_FIXTURES['a correct review'](db, retailReservedBase(db, warehouseKey(1))); });
    const journal = `${clone}-journal`;
    const replace = (point: RetailProbePoint) => {
      if (point !== 'clone-created') return;
      fs.rmSync(journal);
      fs.writeFileSync(journal, 'competitor');
    };
    expect(await run(args, { probe: replace })).toBe(1);
    expect(output()).toEqual({ code: 'retail-reserved-value', events: 0, reviews: 1, imports: 0 });
    expect(fs.existsSync(journal)).toBe(true);
    expect(fs.readFileSync(journal, 'utf8')).toBe('competitor');
    expect(sidecars(clone).filter((name) => fs.existsSync(name))).toEqual([journal]);
  });

  // ROOT's C4 ruling: from its clone's reservation to its end, a preview's clone and the names SQLite keeps beside it are
  // its own. Other runs start at each point a test can see from there on, and finish on their own.
  const RUNNING: readonly RetailProbePoint[] = ['clone-created', 'clone-copied', 'clone-imported'];
  /** Another run, started now: its exit code and what it printed, once it has finished on its own. */
  const alongside = (args: string[]): Promise<[number, unknown]> => {
    let printed = '';
    const sink = { write: (s: string) => { printed += s; } };
    return runRetailCli(args, { env: DISPOSABLE, now: () => NOW, outputAccess: OWNER_ONLY, io: { stdout: sink, stderr: sink } })
      .then((exit) => [exit, JSON.parse(printed)]);
  };
  /** The names SQLite keeps beside `target` that aren't there now: those the preview's SQLite has let go. */
  const released = (target: string) => sidecars(target).slice(1).filter((name) => !fs.existsSync(name)).map((name) => path.basename(name));
  const previewOf = (clone: string, payload: string, declaration: string) =>
    ['preview', '--db', file, '--clone', clone, '--payload', payload, '--declaration', declaration];

  it('refuses a second preview at its clone\'s -wal, which it holds all run, and at its -journal once SQLite has let that go (ROOT\'s C4 ruling)', async () => {
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    const clone = at('clone.db');
    const seconds: Array<[string[], Promise<[number, unknown]>, Promise<[number, unknown]>]> = [];
    const probe = (point: RetailProbePoint) => {
      if (point !== 'clone-copied') return;
      seconds.push([released(clone), alongside(previewOf(`${clone}-wal`, payload, declaration)),
        alongside(previewOf(`${clone}-journal`, payload, declaration))]);
    };
    expect(await run(previewOf(clone, payload, declaration), { probe })).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-previewed' });
    expect(seconds).toHaveLength(1);
    const [[gone, atWal, atJournal]] = seconds;
    // SQLite took the -journal placeholder as the copy's rollback journal and removed it as the copy committed; the -wal
    // and -shm placeholders stay this preview's (they become the clone's WAL and its index) until the clone closes.
    expect(gone).toEqual(['clone.db-journal']);
    expect(await atWal).toEqual([1, { code: 'retail-output-exists' }]);
    // The name SQLite has let go: only the rule refuses it.
    expect(await atJournal).toEqual([1, { code: 'retail-output-name-refused' }]);
    for (const name of [...sidecars(`${clone}-wal`), ...sidecars(`${clone}-journal`)]) expect(fs.existsSync(name), name).toBe(false);
    expect(opened((db) => db.prepare('SELECT purpose FROM retail_imports').pluck().all(), clone)).toEqual(['preview']);
  });

  it('keeps its clone for its whole run: the same clone again is refused at every point, and the clone stays the file it created (ROOT\'s C4 ruling)', async () => {
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    const clone = at('clone.db');
    const fileId = (target: string) => {
      const stat = fs.statSync(target, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    };
    const ids: string[] = [];
    const seconds: Array<Promise<[number, unknown]>> = [];
    const probe = (point: RetailProbePoint) => {
      if (!RUNNING.includes(point)) return;
      ids.push(fileId(clone));
      seconds.push(alongside(previewOf(clone, payload, declaration)));
    };
    expect(await run(previewOf(clone, payload, declaration), { probe })).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-previewed' });
    // Never unlinked or put back: the same file at every point, and once the run has ended.
    expect(ids).toEqual(RUNNING.map(() => fileId(clone)));
    expect(seconds).toHaveLength(RUNNING.length);
    for (const second of seconds) expect(await second).toEqual([1, { code: 'retail-output-exists' }]);
    expect(await run(previewOf(clone, payload, declaration))).toBe(1);
    expect(output()).toEqual({ code: 'retail-output-exists' });
  });

  it('never lets another run take a name SQLite keeps beside its clone: a preview, a backup or a proposal there is refused throughout (ROOT\'s C4 ruling)', async () => {
    const payload = payloadFile('payload.json', syntheticRetailPayload());
    const declaration = declarationFile('declaration.json');
    const clone = at('clone.db');
    const source = identity(file);
    const gone: Partial<Record<RetailProbePoint, string[]>> = {};
    const others: Array<[string, boolean, Promise<[number, unknown]>]> = [];
    const probe = (point: RetailProbePoint) => {
      if (!RUNNING.includes(point)) return;
      gone[point] = released(clone);
      for (const name of [...sidecars(clone).slice(1), at('CLONE.DB-WAL')]) {
        const there = fs.existsSync(name);
        const label = `${point}: ${path.basename(name)}`;
        others.push([`${label}, a preview`, there, alongside(previewOf(name, payload, declaration))]);
        others.push([`${label}, an install's backup`, there, alongside(['install', '--db', file, '--go', go('install'), '--backup', name])]);
        others.push([`${label}, a proposal`, there, alongside(['bindings', 'propose', '--db', file, '--out', name])]);
      }
    };
    expect(await run(previewOf(clone, payload, declaration), { probe })).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-previewed' });
    // Where its SQLite had let a name go, the rule refused it; elsewhere the name was still this preview's.
    expect(gone).toEqual({ 'clone-created': [], 'clone-copied': ['clone.db-journal'], 'clone-imported': ['clone.db-journal'] });
    expect(others).toHaveLength(RUNNING.length * 4 * 3);
    for (const [label, there, other] of others) {
      expect(await other, label).toEqual([1, { code: there ? 'retail-output-exists' : 'retail-output-name-refused' }]);
    }
    // No other run left a file, the clone and its import are whole, and the source is as it was. The names come first:
    // a read of a WAL-mode clone leaves its -wal and -shm behind.
    expect(fs.readdirSync(dir).filter((name) => name.toLowerCase().startsWith('clone.db'))).toEqual(['clone.db']);
    expect(opened((db) => db.prepare('SELECT purpose FROM retail_imports').pluck().all(), clone)).toEqual(['preview']);
    expect(identity(file)).toEqual(source);
  });
});

describe('holdr-retail read-only commands, bindings propose and value-free output', () => {
  it('lists the quarantine and reports, read-only, value-free, with held refs listed', async () => {
    expect(await run(['report', '--db', file])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-reported', schema: 'absent', memberships: [], imports: [] });
    expect(await run(['quarantine', '--db', file])).toBe(0);
    expect(output()).toEqual({ code: 'retail-quarantine-listed', schema: 'absent', receipts: [] });
    await quarantinedReceipt();
    expect(await importFile(payloadFile('held.json', syntheticRetailPayload({ capture: 'e', receipts: [warehouseReceipt(5)],
      held: [heldRecord({ naturalKey: warehouseKey(1) })] })))).toBe(0);
    stdout = '';
    const before = fs.readFileSync(file);
    expect(await run(['quarantine', '--db', file])).toBe(0);
    const listing = output() as { receipts: Array<{ held: string[]; causes: Array<{ reason: string; ref: string }> }> };
    expect(listing.receipts).toHaveLength(1);
    expect(listing.receipts[0].held).toEqual([expect.stringMatching(/^rhd-[a-p]{32}$/)]);
    expect(listing.receipts[0].causes.map((cause) => cause.reason)).toEqual(['receipt-changed', 'receipt-held-later']);
    expect(await run(['report', '--db', file])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-reported', schema: 'present', memberships: [{ folder: 'costco', owner: 'alex' }], possibleOverlap: 0,
      receipts: { warehouse: { active: 1, quarantined: 1 }, gas: { active: 0, quarantined: 0 }, online: { active: 0, quarantined: 0 } },
      causes: { 'receipt-changed': 1, 'receipt-held-later': 1, 'duplicate-across-memberships': 0, 'policy-reread-changed': 0 },
      coverage: { online: { from: '2031-01-01', to: '2031-01-31' }, warehouse: { from: '2031-01-01', to: '2031-01-31' } } });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('proposes bindings to a new owner-only file and prints counts and its SHA-256 only', async () => {
    await quarantinedReceipt();
    const before = fs.readFileSync(file);
    for (const [access, code] of [[standIn([{ sid: USERS_SID, rights: 0x120089, type: 'Allow' }]), 'retail-output-not-owner-only'],
      [{ ...OWNER_ONLY, readAcls: () => { throw new Error('unreadable'); } }, 'retail-output-uncheckable']] as const) {
      expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')], { access })).toBe(1);
      expect(output()).toEqual({ code });
      expect(fs.existsSync(at('proposal.json'))).toBe(false);
    }
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')])).toBe(0);
    expect(output()).toEqual({ code: 'retail-bindings-proposed', proposalSha256: sha256(at('proposal.json')), identities: 1, oneCandidate: 1,
      severalCandidates: 0, noCandidate: 0 });
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')])).toBe(1);
    expect(output()).toEqual({ code: 'retail-output-exists' });
    expect(opened(reservedValuesStored)).toEqual(NO_RESERVED);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('never prints an amount, a last four, a title, a label, a natural key or a capture digest, from any command', async () => {
    const payload = payloadFile('payload.json', syntheticRetailPayload({ receipts: [warehouseReceipt(1), onlineOrder(2)],
      held: [heldRecord({ naturalKey: warehouseKey(9) })] }));
    const declaration = declarationFile('declaration.json');
    await run(['plan', '--db', file, '--payload', payload, '--declaration', declaration]);
    await run(['declare-membership', '--declaration', declaration]);
    await run(['preview', '--db', file, '--clone', at('clone.db'), '--payload', payload, '--declaration', declaration]);
    await install();
    await importFile(payload, { declaration });
    await importFile(payloadFile('second.json', syntheticRetailPayload({ capture: 'd', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] })));
    await run(['plan', '--db', file, '--payload', payload]);
    const review = await reviewFileFromListing('canonical');
    await run(['review-receipt', '--db', file, '--review', review.path, '--go', go('review-receipt', { reviewSha256: sha256(review.path),
      receiptRefs: review.receiptRefs }), '--backup', newBackup()]);
    await run(['quarantine', '--db', file]);
    await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')]);
    await run(['report', '--db', file]);
    await importFile(payloadFile('conflict.json', syntheticRetailPayload({ capture: 'e', membershipLast4: '0011' })));
    expect(transcript).toMatch(/retail-reviewed/);
    expect(transcript).toMatch(/retail-membership-conflict/);
    expect(valueFreeText(transcript)).not.toMatch(SYNTHETIC_RETAIL_VALUES);
    expect(valueFreeText(transcript)).not.toMatch(new RegExp([1_080, 1_000, 5_400, 5_000].join('|') + '|Sample|SAMPLE|costco-(?:order|receipt|line)-'));
  });

  it('imports the converter\'s own output for its synthetic membership capture', async () => {
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    const { json } = convertCostcoCapture({
      folder: 'costco-2', consolidated: capture.consolidated, consolidatedDigest: retailDigest(new TextEncoder().encode('synthetic consolidated file')),
      rawReceipts: capture.rawReceipts.map((entry) => entry.json), rawDetails: capture.rawDetails.map((entry) => entry.json),
      files: 1 + capture.rawReceipts.length + capture.rawDetails.length,
    });
    const payload = write('converted.json', json);
    expect(await install()).toBe(0);
    stdout = '';
    expect(await importFile(payload, { declaration: declarationFile('declaration.json', 'costco-2') })).toBe(0);
    const receipt = output() as { receipts: number; outcomes: { new: number } };
    expect(receipt.receipts).toBeGreaterThan(0);
    expect(receipt.outcomes.new).toBe(receipt.receipts);
  });
});

describe('holdr-retail read-only commands: one read snapshot (plan §8.3, D-PR2-C1)', () => {
  it('answers plan, quarantine and report from the snapshot its STOP read, whatever another connection commits meanwhile', async () => {
    // Another connection's commit, landed after the command's schema check and STOP: an import (receipt 1 sighted
    // changed again, and a new receipt 5), or a stored reserved value.
    const landings: Array<[string, (db: Database.Database) => void]> = [
      ['an import', (db) => { importPayload(db, syntheticRetailPayload({ capture: 'e', receipts: [warehouseReceipt(1, { date: '2031-01-13' }), warehouseReceipt(5)] })); }],
      ['a reserved row', (db) => { RETAIL_RESERVED_FIXTURES['a progression event'](db, retailReservedBase(db, warehouseKey(1))); }],
    ];
    // Quarantine first: its answer passes through no catch that turns an error into an answer (plan's payload refusals do).
    const commands: Array<() => string[]> = [
      () => ['quarantine', '--db', file],
      () => ['report', '--db', file],
      () => ['plan', '--db', file, '--payload', payloadFile('third.json', syntheticRetailPayload({ capture: 'f', receipts: [warehouseReceipt(5)] }))],
    ];
    for (const [what, land] of landings) {
      for (const command of commands) {
        fresh();
        await quarantinedReceipt();
        const args = command();
        const label = `${what}: ${args[0]}`;
        expect(await run(args), label).toBe(0);
        const baseline = output();
        let landed = 0;
        const probe = (point: RetailProbePoint) => {
          if (point !== 'read-checked') return;
          landed += 1;
          writable(land);
        };
        expect(await run(args, { probe }), label).toBe(0);
        expect(landed, label).toBe(1);
        expect(output(), label).toEqual(baseline);
        // The next read is a new snapshot: the import changes its answer, and the reserved row stops it.
        if (what === 'a reserved row') {
          expect(await run(args), label).toBe(1);
          expect(output(), label).toMatchObject({ code: 'retail-reserved-value', events: 1 });
        } else {
          expect(await run(args), label).toBe(0);
          expect(output(), label).not.toEqual(baseline);
        }
      }
    }
  });
});

describe('holdr-retail readers stop on a stored reserved value (plan §5.7)', () => {
  it('refuses retail-reserved-value from every command before any other answer, for each reserved row', async () => {
    for (const [what, add] of Object.entries(RETAIL_RESERVED_FIXTURES)) {
      fresh();
      await quarantinedReceipt();
      const review = await reviewFileFromListing();
      const reviewGo = () => go('review-receipt', { reviewSha256: sha256(review.path), receiptRefs: review.receiptRefs });
      expect(await run(['review-receipt', '--db', file, '--review', review.path, '--go', reviewGo(), '--backup', newBackup()]), what).toBe(0);
      stdout = '';
      const counts = writable((db) => add(db, retailReservedBase(db, warehouseKey(1))));
      const first = at('first.json');
      const taken = backups();
      const commands: string[][] = [
        ['plan', '--db', file],
        ['plan', '--db', file, '--payload', first],
        ['preview', '--db', file, '--clone', at('clone.db'), '--payload', first],
        ['install', '--db', file, '--go', go('install'), '--backup', newBackup()],
        ['import', '--db', file, '--payload', first, '--go', go('import', { inputSha256: sha256(first), membership: { membershipRef: membershipRef() } }),
          '--backup', newBackup()],
        ['quarantine', '--db', file],
        ['review-receipt', '--db', file, '--review', review.path, '--go', reviewGo(), '--backup', newBackup()],
        ['bindings', 'propose', '--db', file, '--out', at('proposal.json')],
        ['report', '--db', file],
      ];
      for (const command of commands) {
        expect(await run(command), `${what}: ${command[0]}`).toBe(1);
        expect(output(), `${what}: ${command.join(' ')}`).toEqual({ code: 'retail-reserved-value', ...counts });
      }
      expect(backups(), what).toEqual(taken);
      expect(fs.existsSync(at('clone.db')), what).toBe(false);
      expect(fs.existsSync(at('proposal.json')), what).toBe(false);
    }
  });
});
