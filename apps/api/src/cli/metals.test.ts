import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { METALS_PRODUCT_REF_MAX, serializeMetalsImportPayload, type MetalsEvent, type MetalsImportPayload, type MetalsOrder } from '@finance-tracker/shared/metals-ledger';
import {
  delivered,
  metalItem,
  syntheticCompetitor,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
} from '@finance-tracker/shared/metals-ledger-fixtures';

import { digest } from '../services/amazon/policy.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { lettersOfHex, METALS_SCHEMA_DIGEST, METALS_SCHEMA_SQL, metalsIdentityDigest, metalsSchemaState, serializeMetalsFolderRegistry, type MetalsIdentity } from '../services/metals/index.js';
import {
  METALS_INTERIM_V0_DIGEST,
  METALS_TABLES,
  MetalsRefusal,
  metalsInterimObjects,
  planMetalsReinstall,
  reinstallMetalsSchema,
  type MetalsReinstallPlan,
  type MetalsReinstallPoint,
} from '../services/metals/index.js';
import { METALS_SCHEMA_INTERIM_V0 } from '../services/metals/schemaInterimV0.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { ALIAS_FOLDERS } from '../testing/windowsAliasPaths.js';
import { ADMINISTRATORS_SID, readCurrentUserSid, readWindowsAcls, restrictToUser, SYSTEM_SID, system32, type WindowsAcl } from '../e2e/windowsAcl.js';
import { nativeFixture } from '../ingress/nativeFixtures.js';
import type { PathObject } from '../ingress/socketPath.js';
import { readPinnedPathcheck } from './darwinPathcheck.js';
import { METALS_CLI_USAGE, runMetalsCli, type MetalsReinstallSeams } from './metals.js';
import { ownerOnlyAcl, ownerOnlyDarwinPath, platformOutputAccess, type OutputAccess } from './ownerOnlyOutput.js';

// Synthetic only: a database made by this build in a scratch directory, invented orders, amounts, last 4s and GO ids.

let template: string, dir: string, file: string, stdout: string, stderr: string;
const NOW = new Date('2030-03-01T12:00:00.000Z');
const REFUSED = 'holdr-metals: input-refused HoldrRefusal\n';
const BASE_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD', 'HOLDR_CONFIG'].includes(name)));
const DISPOSABLE = { ...BASE_ENV, HOLDR_CONFIG: 'none' };
/** A synthetic SID and a stand-in Windows ACL reader for a proposal's place: owner-only unless a test adds an entry. */
const USER_SID = 'S-1-5-21-1000-1000-1000-1001';
const USERS_SID = 'S-1-5-32-545';
const standIn = (extra: WindowsAcl['aces'] = []): OutputAccess => {
  const acl = (): WindowsAcl => {
    const aces: WindowsAcl['aces'] = [{ sid: USER_SID, rights: 0x1f01ff, type: 'Allow' }, { sid: SYSTEM_SID, rights: 0x1f01ff, type: 'Allow' },
      { sid: ADMINISTRATORS_SID, rights: 0x1f01ff, type: 'Allow' }, ...extra];
    return { owner: USER_SID, aces, aceTypes: aces.map((ace) => (ace.type === 'Allow' ? 'AccessAllowed' : 'AccessDenied')) };
  };
  return {
    platform: 'win32', currentUserSid: () => USER_SID,
    readAcls: (paths) => paths.map(() => acl()),
    // The one-handle reader of an existing input: the ACL, and the identity of what the path names.
    readFileAcl: (target) => {
      const stat = fs.statSync(target, { bigint: true });
      return { ...acl(), volume: stat.dev.toString(), index: stat.ino.toString() };
    },
  };
};
const OWNER_ONLY = standIn();
const run = (args: string[], env: NodeJS.ProcessEnv = DISPOSABLE, outputAccess: OutputAccess = OWNER_ONLY, reinstallSeams?: MetalsReinstallSeams) =>
  runMetalsCli(args, {
    env, now: () => NOW, outputAccess, reinstallSeams,
    io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
  });
const write = (name: string, value: unknown) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return target;
};
const at = (name: string) => path.join(dir, name);
const sha256 = (target: string) => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const output = () => {
  const value = JSON.parse(stdout) as Record<string, unknown>;
  stdout = '';
  return value;
};
const goFields = (command: string, patch: Record<string, unknown> = {}) => ({
  format: 'holdr.metals-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command,
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), schemaDigest: METALS_SCHEMA_DIGEST, ...patch,
});
const go = (command: string, patch: Record<string, unknown> = {}) => write(`go-${randomBytes(6).toString('hex')}.json`, goFields(command, patch));
const opened = <T>(fn: (db: Database.Database) => T, target = file) => {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
};
const backups = () => fs.readdirSync(dir).filter((name) => name.startsWith('backup-'));
/** Synthetic values that must never reach the output: amounts, last 4s, the account label and titles. */
const VALUES = /200000|1111|2222|Walmart account|Sample Refinery|Gold Bar/;

const shipped = (date: string): MetalsEvent => ({ kind: 'shipped', date, dateBasis: 'stated', quantity: 1, occurrence: 1 });

function walmartOrder(id: number, events: MetalsEvent[] = [shipped('2030-01-11'), delivered(1, '2030-01-14')],
  massBasis: 'fine' | 'unknown' = 'fine'): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date: '2030-01-10',
    skeleton: [metalItem(0, 200000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000,
    },
    lines: [{
      ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', productRef: 'walmart:100001', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'ozt' }, pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis, design: null,
      quantity: 1, unitPriceMinor: 200000, events, seller: 'Sample Bullion Shop',
    }],
  });
}

/** A CollectPure sale with its payout (the services tests' shape): a disposition and a payout when imported. */
function collectpureSale(id: number): MetalsOrder {
  const payout = { key: syntheticKey('collectpure', 'payout', id), method: 'ach' as const, destinationLast4: '2222', amountMinor: 209000,
    initiatedDate: '2030-02-09', payoutDate: '2030-02-10', status: 'complete' as const };
  return syntheticOrder({
    source: 'collectpure', channel: 'online', id, date: '2030-02-01', status: 'complete', completedDate: '2030-02-10',
    skeleton: [metalItem(0, 210000)],
    components: [{ kind: 'platform-fee', amountMinor: -1000 }],
    payouts: [payout],
    lines: [{
      ordinal: 0, title: 'Sample Mint 1 oz Gold Eagle Coin', productRef: 'collectpure:SKU-EAGLE', metal: 'XAU', form: 'coin',
      statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1, unitPriceMinor: 210000,
      events: [{ kind: 'agreed', date: '2030-02-01', dateBasis: 'stated', quantity: 1, occurrence: 1 }],
    }],
  });
}

function payloadFile(name: string, orders: MetalsOrder[], capture = 'b'): string {
  const payload: MetalsImportPayload = syntheticPayload('walmart', {
    orders, coverage: [syntheticCoverage('online', '2030-01-01', '2030-01-31', null, orders.length)],
  });
  if ('captureDigest' in payload.input) payload.input.captureDigest = capture.repeat(64);
  return write(name, serializeMetalsImportPayload(payload));
}

const install = () => run(['install', '--db', file, '--go', go('install'), '--backup', at(`backup-${randomBytes(4).toString('hex')}.db`)]);
/**
 * Prevention (corrections design r6, section 2.8): a synthetic identity key and the registry of the fixtures' Walmart
 * folder, written owner-only into each scratch directory, and the pin a new account's GO carries.
 */
const IDENTITY_KEY = Buffer.alloc(32, 0x5a);
const WALMART_IDENTITY: MetalsIdentity = { source: 'walmart', folder: 'walmart', identityLast4: null };
const PIN = metalsIdentityDigest(IDENTITY_KEY, WALMART_IDENTITY);
const NEW_ACCOUNT = { label: 'Walmart account', identityDigest: PIN };
const keyText = (key: Buffer) => `${lettersOfHex(key.toString('hex'))}\n`;
const IDENTITY_INPUTS = () => ['--identity-key', at('identity.key'), '--identity-registry', at('registry.json')];
const importGo = (payload: string, account: unknown = NEW_ACCOUNT, patch: Record<string, unknown> = {}) =>
  go('import', { inputSha256: sha256(payload), account, ...patch });
/** The identity inputs, passed exactly when the GO creates an account (its account carries a pin). */
const identityArgs = (goFile: string): string[] => {
  try {
    const pinned = (JSON.parse(fs.readFileSync(goFile, 'utf8')) as { account?: { identityDigest?: unknown } }).account?.identityDigest !== undefined;
    return pinned ? IDENTITY_INPUTS() : [];
  } catch {
    return [];
  }
};
const doImport = (payload: string, goFile: string, backup = `backup-${randomBytes(4).toString('hex')}.db`) =>
  run(['import', '--db', file, '--payload', payload, '--go', goFile, '--backup', at(backup), ...identityArgs(goFile)]);

beforeAll(async () => {
  template = await makeScratchDir('metals-cli-template-');
  const repo = new SqliteStateRepo({ file: path.join(template, 'finance.db') });
  repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1111', currency: 'USD' });
  repo.close();
  const db = new Database(path.join(template, 'finance.db'));
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('metals-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
  write('identity.key', keyText(IDENTITY_KEY));
  write('registry.json', serializeMetalsFolderRegistry({ folders: [WALMART_IDENTITY] }));
});
afterEach(async () => { await removeScratchDir(dir); });

describe('holdr-metals plan and install', () => {
  it('prints its usage, and plans read-only with codes, digests and counts only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(METALS_CLI_USAGE);
    stdout = '';
    const before = fs.readFileSync(file);
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    expect(await run(['plan', '--db', file, '--payload', payload])).toBe(0);
    const plan = output();
    expect(plan).toMatchObject({ code: 'metals-planned', schema: 'absent', schemaDigest: METALS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)),
      objects: { matching: 0, differing: 0, unexpected: 0 }, input: { inputSha256: sha256(payload), source: 'walmart', orders: 1, lines: 1 } });
    expect(JSON.stringify(plan)).not.toMatch(VALUES);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('installs once after a backup; a second install reports already installed and takes none', async () => {
    expect(await run(['install', '--db', file, '--go', go('install'), '--backup', at('backup-1.db')])).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-installed', purpose: 'copy-rehearsal', schemaDigest: METALS_SCHEMA_DIGEST });
    expect(opened(metalsSchemaState)).toBe('present');
    const copy = new Database(at('backup-1.db'), { readonly: true });
    try { expect(metalsSchemaState(copy)).toBe('absent'); } finally { copy.close(); }
    expect(await run(['install', '--db', file, '--go', go('install'), '--backup', at('backup-2.db')])).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-already-installed' });
    expect(fs.existsSync(at('backup-2.db'))).toBe(false);
    expect(await run(['plan', '--db', file])).toBe(0);
    expect(output()).toMatchObject({ schema: 'present', objects: { differing: 0, missing: 0, unexpected: 0 } });
  });

  it('refuses a GO that is not exactly a Root GO for this database, schema and command, before any backup or write', async () => {
    const before = fs.readFileSync(file);
    const bad = [
      go('install', { format: 'holdr.cash-plan-go' }), go('install', { version: 2 }), go('install', { authority: 'Alex' }),
      go('install', { decision: 'HOLD' }), go('install', { purpose: 'production-import' }), go('import'), go('install', { goId: 'G'.repeat(32) }),
      go('install', { databaseRef: digest('/elsewhere/finance.db') }), go('install', { schemaDigest: 'a'.repeat(64) }),
      write('extra.json', { ...goFields('install'), note: 'x' }), write('not-json.json', '{'),
    ];
    for (const goFile of bad) expect(await run(['install', '--db', file, '--go', goFile, '--backup', at(`backup-${randomBytes(4).toString('hex')}.db`)])).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(bad.length));
    expect(stdout).toBe('');
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    for (const args of [['install', '--db', file], ['install', '--db', 'finance.db', '--go', go('install'), '--backup', at('backup-x.db')], ['nonsense']]) {
      stderr = '';
      expect(await run(args)).toBe(1);
      expect(stderr).toBe(REFUSED);
    }
  });

  it('refuses a backup path with a name Windows reads as another file or a device, before any backup or write (ROOT, 11/09)', async () => {
    const before = fs.readFileSync(file);
    for (const folder of ALIAS_FOLDERS) fs.mkdirSync(at(folder));
    // SQLite would back up beside the path checked or into a device, or fail on the file Node made in `run `. `//?/` and
    // `//./` are absolute on every platform, as metals' options require.
    const refused = [at('backup-x.db.'), at('backup-x.db '), at('backup-x.db:stream'), at('NUL'), at('Com1.db'), at('conout$.db'),
      ...ALIAS_FOLDERS.map((folder) => path.join(at(folder), 'backup-x.db')), `//?/${at('backup-x.db')}`, `//./${at('backup-x.db')}`];
    for (const backup of refused) {
      expect(await run(['install', '--db', file, '--go', go('install'), '--backup', backup]), backup).toBe(1);
      expect(output(), backup).toEqual({ code: 'metals-output-name-refused' });
    }
    expect(stderr).toBe('');
    expect(backups()).toEqual([]);
    for (const folder of ALIAS_FOLDERS) expect(fs.readdirSync(at(folder)), folder).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('plans a conflict (exit 1) and never installs over it', async () => {
    const db = new Database(file);
    try { db.exec('CREATE TABLE metals_lots (id TEXT)'); } finally { db.close(); }
    expect(await run(['plan', '--db', file])).toBe(1);
    expect(output()).toMatchObject({ code: 'metals-conflict', schema: 'conflict' });
    expect(await install()).toBe(1);
    expect(output()).toEqual({ code: 'metals-conflict' });
    expect(backups()).toEqual([]);
  });

  it('refuses, before any backup, tables that differ from the declaration only inside a quoted literal (review P299-2)', async () => {
    // One space where the declared label CHECK has two: a valid label like this one would fail it mid-write.
    const changed = METALS_SCHEMA_SQL.map((sql) => sql.replace("label NOT GLOB '*  *'", "label NOT GLOB '* *'"));
    expect(changed.filter((sql, index) => sql !== METALS_SCHEMA_SQL[index])).toHaveLength(1);
    const db = new Database(file);
    try { for (const sql of changed) db.exec(sql); } finally { db.close(); }
    const before = fs.readFileSync(file);
    expect(await run(['plan', '--db', file])).toBe(1);
    expect(output()).toMatchObject({ code: 'metals-conflict', schema: 'conflict', objects: { differing: 1, missing: 0, unexpected: 0 } });
    expect(await install()).toBe(1);
    expect(output()).toEqual({ code: 'metals-conflict' });
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    expect(await doImport(payload, importGo(payload), 'backup-label.db')).toBe(1);
    expect(output()).toEqual({ code: 'metals-conflict' });
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('holdr-metals import and supersede', () => {
  it('imports a payload its GO names after a backup; the same payload again writes nothing', async () => {
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    stderr = '';
    expect(await doImport(payload, importGo(payload), 'backup-0.db')).toBe(1);
    expect(output()).toEqual({ code: 'metals-not-installed' });
    expect(backups()).toEqual([]);
    expect(await install()).toBe(0);
    stdout = '';
    expect(await doImport(payload, importGo(payload), 'backup-1.db')).toBe(0);
    const receipt = output();
    expect(receipt).toMatchObject({ code: 'metals-imported', purpose: 'copy-rehearsal', inputSha256: sha256(payload), accountCreated: true, lines: 1,
      orders: { new: 1 }, competitors: { new: 0, known: 0 }, held: 0, coverage: 1, pending: [] });
    expect(JSON.stringify(receipt)).not.toMatch(VALUES);
    expect(fs.existsSync(at('backup-1.db'))).toBe(true);
    // The backup is a sound copy of the database as it was before the import.
    expect(opened((db) => db.pragma('integrity_check', { simple: true }), at('backup-1.db'))).toBe('ok');
    expect(opened((db) => db.prepare('SELECT count(*) FROM metals_imports').pluck().get(), at('backup-1.db'))).toBe(0);
    expect(opened((db) => db.prepare('SELECT count(*) FROM metals_lots').pluck().get())).toBe(1);
    expect(await doImport(payload, importGo(payload), 'backup-2.db')).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-already-imported', importId: receipt.importId, accountId: receipt.accountId });
    expect(fs.existsSync(at('backup-2.db'))).toBe(false);
  });

  it('refuses a GO naming another database, schema, payload or account shape, and a non-canonical file, before any backup', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const installed = backups();
    const before = fs.readFileSync(file);
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    for (const goFile of [importGo(payload, undefined, { inputSha256: 'a'.repeat(64) }), importGo(payload, undefined, { databaseRef: digest('/elsewhere/finance.db') }),
      importGo(payload, undefined, { schemaDigest: 'b'.repeat(64) }), importGo(payload, undefined, { command: 'install' }), go('import', { inputSha256: sha256(payload) })]) {
      expect(await doImport(payload, goFile)).toBe(1);
    }
    expect(stderr).toBe(REFUSED.repeat(5));
    expect(await doImport(payload, importGo(payload, { label: 'Card 1234', identityDigest: PIN }))).toBe(1);
    expect(output()).toEqual({ code: 'metals-account-invalid' });
    const loose = write('loose.json', JSON.stringify(JSON.parse(fs.readFileSync(payload, 'utf8'))));
    expect(await doImport(loose, importGo(loose))).toBe(1);
    expect(output()).toEqual({ code: 'metals-payload-not-canonical' });
    const invalid = write('invalid.json', serializeMetalsImportPayload({ ...JSON.parse(fs.readFileSync(payload, 'utf8')), version: 2 }));
    expect(await doImport(invalid, importGo(invalid))).toBe(1);
    expect(output()).toEqual({ code: 'metals-payload-invalid', issues: [{ path: '$.version', message: 'is not the expected value' }] });
    expect(backups()).toEqual(installed);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses a payload with a long digit run in its free text before it opens the database', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const installed = backups();
    const before = fs.readFileSync(file);
    const payload: MetalsImportPayload = syntheticPayload('walmart', {
      held: [{ key: syntheticKey('walmart', 'order', 'held'), channel: 'online', date: '2030-01-05', reason: 'field-unsupported', check: 'x1234567890123' }],
    });
    const target = write('long.json', serializeMetalsImportPayload(payload));
    expect(await doImport(target, importGo(target))).toBe(1);
    expect(output()).toEqual({ code: 'metals-payload-free-text', paths: ['$.held[0].check'] });
    expect(await run(['plan', '--db', file, '--payload', target])).toBe(1);
    expect(output()).toEqual({ code: 'metals-payload-free-text', paths: ['$.held[0].check'] });
    expect(backups()).toEqual(installed);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('imports a product ref of the contract\'s whole length, METALS_PRODUCT_REF_MAX characters after its source (contract follow-up 1)', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const order = walmartOrder(1);
    const ref = `walmart:${'a'.repeat(METALS_PRODUCT_REF_MAX)}`;
    const target = payloadFile('long-ref.json', [{ ...order, lines: [{ ...order.lines[0], productRef: ref }] }]);
    expect(await doImport(target, importGo(target))).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-imported' });
    expect(opened((db) => db.prepare('SELECT product_ref FROM metals_lots').pluck().get())).toBe(ref);
  });

  it('quarantines a conflicting capture and resolves it by a GO naming the import and the choice', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const first = payloadFile('first.json', [walmartOrder(1)]);
    expect(await doImport(first, importGo(first))).toBe(0);
    const { accountId } = output();
    const second = payloadFile('second.json', [walmartOrder(1, [shipped('2030-01-11'), delivered(1, '2030-01-15')])], 'c');
    expect(await doImport(second, importGo(second, { accountId }))).toBe(0);
    const conflict = output();
    expect(conflict).toMatchObject({ code: 'metals-imported', accountCreated: false, orders: { conflict: 1 },
      pending: [{ orderKey: walmartOrder(1).key, outcome: 'conflict' }] });
    const supersede = (importId: unknown, patch: Record<string, unknown> = {}, backup = `backup-${randomBytes(4).toString('hex')}.db`) =>
      run(['supersede', '--db', file, '--import', String(importId), '--choose', 'incoming', '--go',
        go('supersede', { importId, orderKey: null, choose: 'incoming', ...patch }), '--backup', at(backup)]);
    expect(await supersede(conflict.importId, { choose: 'active' })).toBe(1);
    expect(stderr).toBe(REFUSED);
    expect(await supersede(conflict.importId)).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-superseded', choose: 'incoming', orders: 1, before: { conflict: 1, quarantined: 1 },
      after: { conflict: 0, quarantined: 0 } });
    expect(await supersede(conflict.importId, {}, 'backup-resolved.db')).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-already-resolved', orders: 0 });
    expect(fs.existsSync(at('backup-resolved.db'))).toBe(false);
  });
});

describe('holdr-metals bindings and report', () => {
  const checkingId = `chk-acct-${'b'.repeat(32)}`;
  beforeEach(async () => {
    expect(await install()).toBe(0);
    const db = new Database(file);
    try {
      installCheckingSchema(db);
      db.prepare(`INSERT INTO checking_accounts (id, institution, account_type, last4, label, currency, status, created_at)
        VALUES (?, 'testbank', 'checking', '2222', 'Synthetic Checking', 'USD', 'active', '2030-01-01T00:00:00.000Z')`).run(checkingId);
    } finally { db.close(); }
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    expect(await doImport(payload, importGo(payload))).toBe(0);
    stdout = '';
  });

  it('refuses propose and report with no lease protocol outside a disposable stack', async () => {
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')], BASE_ENV)).toBe(1);
    expect(await run(['report', '--db', file], BASE_ENV)).toBe(1);
    expect(stderr).toBe('holdr-metals: propose-refused no-shared-lease\nholdr-metals: report-refused no-shared-lease\n');
    expect(fs.existsSync(at('proposal.json'))).toBe(false);
  });

  it('proposes to an owner-only file, approves exactly the named pairs, and revokes them', async () => {
    // Every platform, through the stand-in owner-only check; each platform's real check has its own test below.
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')])).toBe(0);
    const proposed = output();
    expect(proposed).toMatchObject({ code: 'metals-bindings-proposed', proposalSha256: sha256(at('proposal.json')), identities: 1, card: 1, checking: 0,
      oneCandidate: 1, bound: 0 });
    expect(JSON.stringify(proposed)).not.toMatch(VALUES);
    const proposal = JSON.parse(fs.readFileSync(at('proposal.json'), 'utf8'));
    const card = proposal.identities[0].candidates[0].accountId as string;
    const pairs = [{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: card }];
    const approve = (patch: Record<string, unknown> = {}, backup = `backup-${randomBytes(4).toString('hex')}.db`) =>
      run(['bindings', 'approve', '--db', file, '--proposal', at('proposal.json'), '--go',
        go('bindings-approve', { proposalSha256: proposed.proposalSha256, inventoryDigest: proposed.inventoryDigest, pairs, ...patch }), '--backup', at(backup)]);
    expect(await approve({ proposalSha256: 'c'.repeat(64) })).toBe(1);
    expect(stderr).toBe(REFUSED);
    expect(await approve({ pairs: [{ ...pairs[0], last4: '9999' }] })).toBe(1);
    expect(output()).toEqual({ code: 'metals-pairs-invalid' });
    // The same proposal in other bytes: a GO naming those bytes is still refused, before any backup.
    const loose = write('loose-proposal.json', JSON.stringify(proposal));
    expect(await run(['bindings', 'approve', '--db', file, '--proposal', loose, '--go', go('bindings-approve', { proposalSha256: sha256(loose),
      inventoryDigest: proposed.inventoryDigest, pairs }), '--backup', at('backup-loose.db')])).toBe(1);
    expect(output()).toEqual({ code: 'metals-proposal-not-canonical' });
    expect(fs.existsSync(at('backup-loose.db'))).toBe(false);
    expect(await approve()).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-bindings-approved', activated: 1, card: 1, closedAccounts: 0 });
    expect(await approve({}, 'backup-again.db')).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-bindings-already-active', alreadyActive: 1 });
    expect(fs.existsSync(at('backup-again.db'))).toBe(false);
    const bindingId = opened((db) => db.prepare('SELECT binding_id FROM metals_bindings').pluck().get()) as string;
    expect(await run(['bindings', 'revoke', '--db', file, '--go', go('bindings-revoke', { bindingIds: [bindingId] }), '--backup', at('backup-r.db')])).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-bindings-revoked', revoked: 1 });
    expect(opened((db) => db.prepare('SELECT state FROM metals_bindings').pluck().get())).toBe('revoked');
  });

  it('refuses an approval once an account changed since the proposal', async () => {
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')])).toBe(0);
    const proposed = output();
    const card = JSON.parse(fs.readFileSync(at('proposal.json'), 'utf8')).identities[0].candidates[0].accountId as string;
    const repo = new SqliteStateRepo({ file });
    repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '1111', currency: 'USD' });
    repo.close();
    const goFile = go('bindings-approve', { proposalSha256: proposed.proposalSha256, inventoryDigest: proposed.inventoryDigest,
      pairs: [{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: card }] });
    expect(await run(['bindings', 'approve', '--db', file, '--proposal', at('proposal.json'), '--go', goFile, '--backup', at('backup-d.db')])).toBe(1);
    expect(output()).toEqual({ code: 'metals-inventory-changed' });
    expect(fs.existsSync(at('backup-d.db'))).toBe(false);
  });

  it('writes a proposal only where its owner alone can open it, and leaves no file otherwise (review P299-1)', async () => {
    const shared = standIn([{ sid: USERS_SID, rights: 0x120089, type: 'Allow' }]);
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')], DISPOSABLE, shared)).toBe(1);
    expect(output()).toEqual({ code: 'metals-output-not-owner-only' });
    expect(fs.existsSync(at('proposal.json'))).toBe(false);
    // The directory passes and the new empty file fails: the file is removed before a byte of the proposal is written.
    const checked: string[] = [];
    const fileOpen: OutputAccess = {
      ...OWNER_ONLY,
      readAcls: (paths) => paths.map((target) => {
        checked.push(path.basename(target));
        return (target.endsWith('proposal.json') ? shared : OWNER_ONLY).readAcls([target])[0];
      }),
    };
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal.json')], DISPOSABLE, fileOpen)).toBe(1);
    expect(output()).toEqual({ code: 'metals-output-not-owner-only' });
    expect(checked.filter((name) => name === 'proposal.json')).toHaveLength(1);
    expect(checked.filter((name) => name !== 'proposal.json')).toHaveLength(2);
    expect(fs.existsSync(at('proposal.json'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('on Windows, writes a proposal only into a directory its real ACL keeps owner-only', async () => {
    const sid = readCurrentUserSid();
    const owned = at('owned');
    fs.mkdirSync(owned);
    restrictToUser(owned, sid);
    expect(await run(['bindings', 'propose', '--db', file, '--out', path.join(owned, 'proposal.json')], DISPOSABLE, platformOutputAccess)).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-bindings-proposed' });
    expect(ownerOnlyAcl(readWindowsAcls([path.join(owned, 'proposal.json')])[0], sid)).toBe(true);
    const shared = at('shared');
    fs.mkdirSync(shared);
    restrictToUser(shared, sid);
    execFileSync(system32('icacls.exe'), [shared, '/grant', `*${USERS_SID}:(OI)(CI)R`], { stdio: 'ignore' });
    expect(await run(['bindings', 'propose', '--db', file, '--out', path.join(shared, 'proposal.json')], DISPOSABLE, platformOutputAccess)).toBe(1);
    expect(output()).toEqual({ code: 'metals-output-not-owner-only' });
    expect(fs.existsSync(path.join(shared, 'proposal.json'))).toBe(false);
  });

  it.runIf(process.platform === 'linux')('on Linux, writes a proposal only into a directory with no group or other access', async () => {
    const owned = at('owned');
    fs.mkdirSync(owned, { mode: 0o700 });
    fs.chmodSync(owned, 0o700);
    expect(await run(['bindings', 'propose', '--db', file, '--out', path.join(owned, 'proposal.json')], DISPOSABLE, platformOutputAccess)).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-bindings-proposed' });
    expect(fs.statSync(path.join(owned, 'proposal.json')).mode & 0o777).toBe(0o600);
    const shared = at('shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o755);
    expect(await run(['bindings', 'propose', '--db', file, '--out', path.join(shared, 'proposal.json')], DISPOSABLE, platformOutputAccess)).toBe(1);
    expect(output()).toEqual({ code: 'metals-output-not-owner-only' });
    expect(fs.existsSync(path.join(shared, 'proposal.json'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('on macOS, writes a proposal only into a directory the pinned reader finds owner-only, and refuses one that inherited an allow for everyone', async () => {
    // The repository's own build of holdr-pathcheck and its pin, in a short directory (the reader takes paths of 100 bytes).
    const fixture = nativeFixture();
    try {
      const reader: OutputAccess = {
        platform: 'darwin', currentUserSid: () => USER_SID, readAcls: () => [],
        darwin: { currentUid: () => process.getuid!(), readPath: (target) => readPinnedPathcheck(target, fixture.native) },
      };
      const own = fixture.mkdir('own', 0o700);
      expect(await run(['bindings', 'propose', '--db', file, '--out', path.join(own, 'p.json')], DISPOSABLE, reader)).toBe(0);
      expect(output()).toMatchObject({ code: 'metals-bindings-proposed' });
      const [, written] = readPinnedPathcheck(path.join(own, 'p.json'), fixture.native).slice(-2) as PathObject[];
      expect(ownerOnlyDarwinPath(written, process.getuid!())).toBe(true);
      const parent = fixture.mkdir('parent', 0o700);
      fixture.acl(parent, 'group:everyone allow list,search,file_inherit,directory_inherit');
      const shared = path.join(parent, 'shared');
      fs.mkdirSync(shared, { mode: 0o700 });
      const [sharedRecord] = readPinnedPathcheck(shared, fixture.native).slice(-1) as PathObject[];
      expect(sharedRecord.acl).toContainEqual(expect.objectContaining({ type: 'allow', principal: 'gid', flags: expect.arrayContaining(['inherited']) }));
      expect(await run(['bindings', 'propose', '--db', file, '--out', path.join(shared, 'p.json')], DISPOSABLE, reader)).toBe(1);
      expect(output()).toEqual({ code: 'metals-output-not-owner-only' });
      expect(fs.existsSync(path.join(shared, 'p.json'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it('reports one strict line of counts and dates', async () => {
    expect(await run(['report', '--db', file])).toBe(0);
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.split('\n')).toHaveLength(2);
    const report = output();
    expect(report).toMatchObject({ code: 'metals-report', schema: 'present', accounts: 1, imports: 1, orders: { buy: 1, sell: 0 }, lots: 1,
      newestImport: '2030-03-01', orderDates: { from: '2030-01-10', to: '2030-01-10' } });
    expect(JSON.stringify(report)).not.toMatch(VALUES);
    expect(JSON.stringify(report)).not.toMatch(/[0-9]{5,}/);
  });
});

describe('holdr-metals held records', () => {
  it('keeps a payload\'s held records with its import', async () => {
    expect(await install()).toBe(0);
    const payload: MetalsImportPayload = syntheticPayload('walmart', {
      held: [{ key: syntheticKey('walmart', 'order', 'held'), channel: 'online', date: '2030-01-05', reason: 'field-unsupported', check: 'driver-tip' }],
    });
    const target = write('held.json', serializeMetalsImportPayload(payload));
    stdout = '';
    expect(await doImport(target, importGo(target))).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-imported', held: 1, orders: { new: 0 } });
    expect(opened((db) => db.prepare('SELECT reason, check_code, record_date FROM metals_holds').get()))
      .toEqual({ reason: 'field-unsupported', check_code: 'driver-tip', record_date: '2030-01-05' });
  });
});

describe('holdr-metals reinstall (the interim v0 ledger swapped for version 1; the reinstall delta, r1)', () => {
  const checkingId = `chk-acct-${'c'.repeat(32)}`;
  /** The fixtures' CollectPure folder: its new account's GO carries a pin like any other (r6, section 2.8). */
  const COLLECTPURE_IDENTITY: MetalsIdentity = { source: 'collectpure', folder: 'collectpure', identityLast4: null };
  /** The checking schema and one synthetic checking account (last 4 2222): part of everything else, live and rebuilt. */
  const withChecking = (target: string) => {
    const db = new Database(target);
    try {
      installCheckingSchema(db);
      db.prepare(`INSERT INTO checking_accounts (id, institution, account_type, last4, label, currency, status, created_at)
        VALUES (?, 'testbank', 'checking', '2222', 'Synthetic Checking', 'USD', 'active', '2030-01-01T00:00:00.000Z')`).run(checkingId);
    } finally { db.close(); }
  };
  const competitor = syntheticCompetitor('walmart', 'online', 77, '2030-01-12', {
    fulfilment: { shipments: 2 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 50000 }],
    refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 50000,
  });
  /** A Walmart capture carrying the competitor and its coverage, and (the first one only) a held record. */
  const walmartCapture = (name: string, orders: MetalsOrder[], capture: string, held: boolean) => {
    const payload = syntheticPayload('walmart', {
      orders, competitors: [competitor],
      held: held ? [{ key: syntheticKey('walmart', 'order', 'held-1'), channel: 'online', date: '2030-01-05', reason: 'field-unsupported', check: 'driver-tip' }] : [],
      coverage: [syntheticCoverage('online', '2030-01-01', '2030-01-31', null, orders.length)],
    });
    if ('captureDigest' in payload.input) payload.input.captureDigest = capture.repeat(64);
    return write(name, serializeMetalsImportPayload(payload));
  };
  /** One owner decision as v0 holds it at birth, through a connection of its own (no CLI command writes one). */
  const decide = (target: string, rowid: number, productRef: string) => {
    const db = new Database(target);
    try {
      db.prepare(`INSERT INTO metals_owner_decisions (rowid, decision_id, kind, scope, product_ref, fingerprint, answer, preview_digest,
        decided_at, decided_by) VALUES (?, ?, 'bullion', 'product', ?, ?, 'bullion', ?, '2030-02-20T12:00:00.000Z', ?)`)
        .run(rowid, `mtl-dec-${'ghij'[rowid % 4].repeat(32)}`, productRef, 'e'.repeat(64), 'f'.repeat(64), `usr_${'k'.repeat(32)}`);
    } finally { db.close(); }
  };
  /**
   * A v0 ledger in `file` with rows in every one of v0's 17 tables (review r1, REINSTALL-ALL-TABLE-FIXTURE), each in a
   * state v0 accepts at birth (nothing superseded, resolved, voided or revoked). Version 1 is installed and written only
   * through this CLI: three Walmart buys with a competitor, a held record and coverage; the same orders captured again
   * as an observation, a policy proposal and a factual conflict, with the competitor seen again; a CollectPure sale with
   * its payout; a card pair and the CollectPure checking pair bound. Its rows are then copied by v0's own columns into a
   * fresh copy of the template whose metals objects are v0's statements, and one owner decision is added (no CLI command
   * writes one). The template's own tables and the checking schema with its account are the everything-else the swap
   * must leave alone. Returns v0's plan.
   */
  const v0Ledger = async (): Promise<MetalsReinstallPlan> => {
    expect(await install()).toBe(0);
    withChecking(file);
    stdout = '';
    const first = walmartCapture('payload-v0-1.json', [walmartOrder(1), walmartOrder(2), walmartOrder(3)], 'b', true);
    expect(await doImport(first, importGo(first))).toBe(0);
    const { accountId } = output();
    const second = walmartCapture('payload-v0-2.json',
      [walmartOrder(1), walmartOrder(2, undefined, 'unknown'), walmartOrder(3, [shipped('2030-01-11'), delivered(1, '2030-01-15')])], 'c', false);
    expect(await doImport(second, importGo(second, { accountId }))).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-imported', accountCreated: false, orders: { observation: 1, proposal: 1, conflict: 1 } });
    const sale = write('payload-v0-3.json', serializeMetalsImportPayload(syntheticPayload('collectpure', { orders: [collectpureSale(10)] })));
    write('registry.json', serializeMetalsFolderRegistry({ folders: [WALMART_IDENTITY, COLLECTPURE_IDENTITY] }));
    expect(await doImport(sale, importGo(sale, { label: 'CollectPure account', identityDigest: metalsIdentityDigest(IDENTITY_KEY, COLLECTPURE_IDENTITY) })))
      .toBe(0);
    expect(output()).toMatchObject({ code: 'metals-imported', accountCreated: true, orders: { new: 1 } });
    expect(await run(['bindings', 'propose', '--db', file, '--out', at('proposal-v0.json')])).toBe(0);
    const proposed = output();
    const card = opened((db) => db.prepare('SELECT id FROM card_accounts').pluck().get()) as string;
    const pairs = [
      { kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: card },
      { kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: checkingId },
    ];
    expect(await run(['bindings', 'approve', '--db', file, '--proposal', at('proposal-v0.json'), '--go',
      go('bindings-approve', { proposalSha256: proposed.proposalSha256, inventoryDigest: proposed.inventoryDigest, pairs }),
      '--backup', at(`backup-${randomBytes(4).toString('hex')}.db`)])).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-bindings-approved', activated: 2, card: 1, checking: 1 });
    const source = at('source-v1.db');
    const live = new Database(file);
    try { live.prepare('VACUUM INTO ?').run(source); } finally { live.close(); }
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    fs.copyFileSync(path.join(template, 'finance.db'), file);
    withChecking(file);
    const db = new Database(file);
    try {
      db.pragma('foreign_keys = OFF');
      for (const sql of METALS_SCHEMA_INTERIM_V0.statements) db.exec(sql);
      db.prepare('ATTACH DATABASE ? AS src').run(source);
      db.transaction(() => {
        for (const table of metalsInterimObjects().tables) {
          const columns = (db.pragma(`main.table_info(${table})`) as Array<{ name: string }>).map(({ name }) => `"${name}"`).join(', ');
          db.exec(`INSERT INTO main."${table}" (rowid, ${columns}) SELECT rowid, ${columns} FROM src."${table}" ORDER BY rowid`);
        }
      })();
      db.exec('DETACH DATABASE src');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
    fs.rmSync(source);
    decide(file, 1, 'walmart:100001');
    const plan = opened(planMetalsReinstall);
    expect(plan).not.toBeNull();
    // Every v0 table holds rows, and both kinds of binding are active.
    expect(Object.keys(plan!.counts)).toHaveLength(17);
    expect(Object.entries(plan!.counts).filter(([, rows]) => rows === 0)).toEqual([]);
    expect(plan!.activeBindings).toEqual({ card: 1, checking: 1 });
    return plan!;
  };
  /** Everything but the metals objects: every other schema row, and every other table's rows (sorted), as text. */
  const everythingElse = () => opened((db) => {
    const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_master
      WHERE NOT (lower(name) LIKE 'metals\\_%' ESCAPE '\\' OR lower(tbl_name) LIKE 'metals\\_%' ESCAPE '\\') ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
    const data = schema.filter((row) => row.type === 'table')
      .map((row) => [row.name, (db.prepare(`SELECT * FROM main."${row.name}"`).all() as unknown[]).map((value) => JSON.stringify(value)).sort()]);
    return JSON.stringify({ schema, data });
  });
  const reinstallGo = (counts: Record<string, number>, patch: Record<string, unknown> = {}) =>
    go('reinstall', { fromDigest: METALS_INTERIM_V0_DIGEST, counts, ...patch });
  const reinstall = (goFile: string, backup = `backup-${randomBytes(4).toString('hex')}.db`, seams?: MetalsReinstallSeams) =>
    run(['reinstall', '--db', file, '--go', goFile, '--backup', at(backup)], DISPOSABLE, OWNER_ONLY, seams);
  /**
   * A database whole, as text (review r1: complete rows, never counts alone): every schema row, and every table's rows
   * with their rowids in rowid order (a WITHOUT ROWID table's rows sorted by their own content).
   */
  const whole = (target = file) => opened((db) => {
    const schema = db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_master ORDER BY type, name').all() as Array<{ type: string; name: string; sql: string | null }>;
    const data = schema.filter((row) => row.type === 'table').map((row) => [row.name, /\bWITHOUT\s+ROWID\b/i.test(row.sql ?? '')
      ? (db.prepare(`SELECT * FROM main."${row.name}"`).all() as unknown[]).map((value) => JSON.stringify(value)).sort()
      : db.prepare(`SELECT rowid AS "(rowid)", * FROM main."${row.name}" ORDER BY rowid`).all()]);
    return JSON.stringify({ schema, data });
  }, target);
  const restore = (from: string) => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    fs.copyFileSync(from, file);
  };
  /** A writer connection's change to `file`, made with enforcement off (a fixture, never the CLI). */
  const alter = (sql: string) => {
    const db = new Database(file);
    try { db.pragma('foreign_keys = OFF'); db.exec(sql); } finally { db.close(); }
  };
  const refusalOf = (fn: () => unknown): string | null => {
    try {
      fn();
    } catch (error) {
      if (error instanceof MetalsRefusal) return error.code;
      throw error;
    }
    return null;
  };

  it('plans the swap, refuses every other command on v0, then drops exactly v0 and installs version 1, everything else as it was', async () => {
    const { counts, activeBindings } = await v0Ledger();
    expect(counts).toMatchObject({ metals_accounts: 2, metals_imports: 3, metals_orders: 4, metals_bindings: 2, metals_owner_decisions: 1 });
    const v0 = whole();
    const others = everythingElse();
    const before = fs.readFileSync(file);
    const kept = backups();
    // plan: read-only, the swap's counts, which a GO pins, and v0's active bindings, which the runbook re-records.
    expect(await run(['plan', '--db', file])).toBe(0);
    const plan = output();
    expect(plan).toEqual({
      code: 'metals-reinstall-planned', schema: 'conflict', schemaDigest: METALS_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)),
      objects: { expected: 84, matching: expect.any(Number), differing: expect.any(Number), missing: expect.any(Number), unexpected: expect.any(Number) },
      reinstall: {
        fromDigest: METALS_INTERIM_V0_DIGEST, from: { digest: METALS_INTERIM_V0_DIGEST, objects: 84 }, to: { digest: METALS_SCHEMA_DIGEST, objects: 84 },
        counts, activeBindings: { card: 1, checking: 1 },
      },
    });
    expect(JSON.stringify(plan)).not.toMatch(VALUES);
    // Every other command refuses v0 as a conflict, fail-closed, before any backup.
    expect(await install()).toBe(1);
    expect(output()).toEqual({ code: 'metals-conflict' });
    const payload = payloadFile('payload-after.json', [walmartOrder(3)]);
    expect(await doImport(payload, importGo(payload))).toBe(1);
    expect(output()).toEqual({ code: 'metals-conflict' });
    expect(await run(['report', '--db', file])).toBe(1);
    expect(output()).toEqual({ code: 'metals-conflict', schema: 'conflict' });
    expect(backups()).toEqual(kept);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // The swap.
    expect(await reinstall(reinstallGo(counts), 'backup-reinstall.db')).toBe(0);
    const receipt = output();
    const objects = metalsInterimObjects();
    expect(receipt).toEqual({
      code: 'metals-reinstalled', purpose: 'copy-rehearsal', goId: expect.stringMatching(/^[0-9a-f]{32}$/), databaseRef: digest(path.resolve(file)),
      fromDigest: METALS_INTERIM_V0_DIGEST, schemaDigest: METALS_SCHEMA_DIGEST,
      from: { digest: METALS_INTERIM_V0_DIGEST, objects: 84 }, to: { digest: METALS_SCHEMA_DIGEST, objects: 84 },
      dropped: { tables: 17, indexes: objects.indexes.length, triggers: objects.triggers.length }, rows: counts, activeBindings,
    });
    expect(JSON.stringify(receipt)).not.toMatch(VALUES);
    expect(stderr).toBe('');
    // Version 1, present and empty; everything else exactly as it was; the backup holds v0, whole.
    opened((db) => {
      expect(metalsSchemaState(db)).toBe('present');
      for (const table of METALS_TABLES) expect(db.prepare(`SELECT count(*) FROM main."${table}"`).pluck().get()).toBe(0);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
    expect(everythingElse()).toBe(others);
    expect(backups().sort()).toEqual([...kept, 'backup-reinstall.db'].sort());
    // Reading the backup (a WAL database) makes its -wal and -shm beside it, so the list is checked first. It holds v0,
    // whole: every schema row and every row, not just the counts.
    expect(whole(at('backup-reinstall.db'))).toBe(v0);
    expect(opened((db) => planMetalsReinstall(db)?.counts, at('backup-reinstall.db'))).toEqual(counts);
    // Again: version 1 is there, so no backup and no write.
    const swapped = fs.readFileSync(file);
    expect(await reinstall(reinstallGo(counts), 'backup-again.db')).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-already-installed', fromDigest: METALS_INTERIM_V0_DIGEST, schemaDigest: METALS_SCHEMA_DIGEST });
    expect(fs.existsSync(at('backup-again.db'))).toBe(false);
    expect(fs.readFileSync(file).equals(swapped)).toBe(true);
    // The re-import: v0's payload lands in version 1 as new data.
    const again = payloadFile('payload-again.json', [walmartOrder(1), walmartOrder(2)]);
    expect(await doImport(again, importGo(again))).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-imported', accountCreated: true, orders: { new: 2 } });
  });

  it('refuses before any backup: a GO not pinned to this swap, other counts, anything but exactly v0, and an unclean foreign key', async () => {
    const { counts } = await v0Ledger();
    const pristine = at('pristine-v0.db');
    fs.copyFileSync(file, pristine);
    const kept = backups();
    const before = fs.readFileSync(file);
    stderr = '';
    // The GO's own fields, each wrong in turn: an input refusal, before the database is opened.
    const wrong: Array<Record<string, unknown>> = [
      { fromDigest: METALS_SCHEMA_DIGEST }, { fromDigest: 'f'.repeat(64) }, { schemaDigest: METALS_INTERIM_V0_DIGEST },
      { purpose: 'production-install' }, { databaseRef: digest(path.resolve(at('other.db'))) }, { command: 'install' },
      { counts: { ...counts, metals_accounts: -1 } }, { counts: { ...counts, metals_accounts: 1.5 } },
      { counts: { ...counts, metals_accounts: '1' } }, { counts: { ...counts, extra: 0 } },
      { counts: Object.fromEntries(Object.entries(counts).slice(1)) }, { counts: [] }, { counts: null },
    ];
    for (const patch of wrong) expect(await reinstall(reinstallGo(counts, patch))).toBe(1);
    expect(stderr).toBe(REFUSED.repeat(wrong.length));
    expect(stdout).toBe('');
    // Counts other than the ledger's: the GO doesn't describe it.
    expect(await reinstall(reinstallGo({ ...counts, metals_imports: counts.metals_imports + 1 }))).toBe(1);
    expect(output()).toEqual({ code: 'metals-go-mismatch' });
    expect(backups()).toEqual(kept);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // Anything but exactly v0 is a conflict, and plan says so.
    const { triggers, indexes } = metalsInterimObjects();
    const trigger = METALS_SCHEMA_INTERIM_V0.statements.find((sql) => sql.startsWith(`CREATE TRIGGER ${triggers[0]}`))!;
    const drift = [
      'CREATE VIEW metals_extra AS SELECT 1 AS one',
      `CREATE VIEW metals_quarantine AS SELECT 'owner-reported-error' AS reason, '${'d'.repeat(32)}' AS go_id, '2030-03-20T16:00:00.000Z' AS since, '' AS ref, '${'e'.repeat(32)}' AS nonce`,
      `DROP TRIGGER ${triggers[0]}`,
      `${trigger.replace(`CREATE TRIGGER ${triggers[0]}`, `DROP TRIGGER ${triggers[0]}; CREATE TRIGGER ${triggers[0]}`).replace("RAISE(ABORT, '", "RAISE(ABORT, 'synthetic ")}`,
      `DROP INDEX ${indexes[0]}; CREATE INDEX ${indexes[0]} ON metals_accounts (label)`,
    ];
    for (const sql of drift) {
      restore(pristine);
      alter(sql);
      const altered = fs.readFileSync(file);
      expect(await run(['plan', '--db', file])).toBe(1);
      expect(output()).toMatchObject({ code: 'metals-conflict', schema: 'conflict' });
      expect(await reinstall(reinstallGo(counts))).toBe(1);
      expect(output()).toEqual({ code: 'metals-conflict' });
      expect(fs.readFileSync(file).equals(altered)).toBe(true);
    }
    // Nothing installed at all.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    fs.copyFileSync(path.join(template, 'finance.db'), file);
    expect(await reinstall(reinstallGo(counts))).toBe(1);
    expect(output()).toEqual({ code: 'metals-not-installed' });
    // A foreign-key violation outside the metals tables would fail the swap's own check: refused first, a count only.
    restore(pristine);
    alter('CREATE TABLE synthetic_parent (id INTEGER PRIMARY KEY); CREATE TABLE synthetic_child (parent INTEGER REFERENCES synthetic_parent(id)); INSERT INTO synthetic_child VALUES (7)');
    expect(await reinstall(reinstallGo(counts))).toBe(1);
    expect(output()).toEqual({ code: 'metals-foreign-keys-unclean', violations: 1 });
    expect(backups()).toEqual(kept);
  });

  it('refuses a plan another connection changed between the read-only preflight and the fence; that committed row survives, in the ledger and the backup', async () => {
    const { counts } = await v0Ledger();
    const kept = backups();
    let preflighted = '';
    let drifted = '';
    // The seam runs after the read-only preflight passed and before the fence's BEGIN IMMEDIATE, with the command's own
    // writer connection open: a second connection commits one more owner decision there.
    const beforeFence = () => {
      preflighted = whole();
      decide(file, 2, 'walmart:100002');
      drifted = whole();
    };
    expect(await reinstall(reinstallGo(counts), 'backup-drift.db', { beforeFence })).toBe(1);
    expect(output()).toEqual({ code: 'metals-plan-changed' });
    expect(stderr).toBe('');
    expect(drifted).not.toBe(preflighted);
    expect(opened((db) => planMetalsReinstall(db)?.counts)).toEqual({ ...counts, metals_owner_decisions: counts.metals_owner_decisions + 1 });
    // Nothing of the swap remains, and the committed row does: in the ledger, and in the backup the fence took after it.
    expect(whole()).toBe(drifted);
    expect(backups().sort()).toEqual([...kept, 'backup-drift.db'].sort());
    expect(whole(at('backup-drift.db'))).toBe(drifted);
  });

  it('rolls the whole swap back through the command, v0 whole in the ledger and the backup, when its own check fails or any step throws', async () => {
    const { counts } = await v0Ledger();
    // A table outside metals whose rows cascade from v0's accounts: with enforcement on, dropping them would delete its rows.
    alter('CREATE TABLE synthetic_metals_note (account_id TEXT REFERENCES metals_accounts(account_id) ON DELETE CASCADE); '
      + 'INSERT INTO synthetic_metals_note SELECT account_id FROM metals_accounts');
    expect(everythingElse()).toContain('synthetic_metals_note');
    const v0 = whole();
    // The swap's own check: after the drops (enforcement off, so no cascade), the note's accounts are gone from version 1.
    expect(await reinstall(reinstallGo(counts), 'backup-unverified.db')).toBe(1);
    expect(output()).toEqual({ code: 'metals-reinstall-unverified' });
    expect(stderr).toBe('');
    expect(whole()).toBe(v0);
    expect(whole(at('backup-unverified.db'))).toBe(v0);
    // A throw at each of the swap's points inside the fence, through the command and its fenced writer: a value-free
    // failure, and everything rolled back.
    for (const point of ['checked', 'dropped', 'created'] as const) {
      const probe = (reached: MetalsReinstallPoint) => {
        if (reached === point) throw new Error(`a synthetic failure once ${point}`);
      };
      expect(await reinstall(reinstallGo(counts), `backup-${point}.db`, { probe })).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toBe('holdr-metals: operation-failed HoldrDbError UNKNOWN\n');
      stderr = '';
      expect(whole()).toBe(v0);
      expect(whole(at(`backup-${point}.db`))).toBe(v0);
    }
  });

  it('refuses, called directly, a swap outside a fence or with foreign-key enforcement on', async () => {
    const { counts } = await v0Ledger();
    const v0 = whole();
    const db = new Database(file);
    try {
      db.pragma('foreign_keys = OFF');
      expect(refusalOf(() => reinstallMetalsSchema(db, counts))).toBe('metals-unfenced');
      db.pragma('foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      expect(refusalOf(() => reinstallMetalsSchema(db, counts))).toBe('metals-foreign-keys-on');
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
    expect(whole()).toBe(v0);
  });

  it('is atomic to every other connection: a reader sees v0 whole until COMMIT, and no other writer can start', async () => {
    const { counts } = await v0Ledger();
    const writer = new Database(file);
    try {
      writer.pragma('foreign_keys = OFF');
      writer.exec('BEGIN IMMEDIATE');
      let seen: unknown = null;
      reinstallMetalsSchema(writer, counts, (point) => {
        if (point !== 'created') return;
        const reader = new Database(file, { readonly: true, fileMustExist: true });
        const other = new Database(file, { fileMustExist: true });
        try {
          other.pragma('busy_timeout = 0');
          let busy: string | null = null;
          try { other.exec('BEGIN IMMEDIATE'); } catch (error) { busy = (error as { code?: string }).code ?? 'unknown'; }
          seen = { state: metalsSchemaState(reader), counts: planMetalsReinstall(reader)?.counts, busy };
        } finally {
          reader.close();
          other.close();
        }
      });
      expect(seen).toEqual({ state: 'conflict', counts, busy: 'SQLITE_BUSY' });
      writer.exec('COMMIT');
    } finally {
      writer.close();
    }
    expect(opened(metalsSchemaState)).toBe('present');
  });
});

describe('holdr-metals identity pin (corrections design r6, section 2.8)', () => {
  const NOT_OWNER_ONLY = standIn([{ sid: USERS_SID, rights: 0xa9, type: 'Allow' }]);
  /** A terminal stand-in for the CLI's own no-echo reader: a TTY that types each answer, then Enter, when read. */
  const terminal = (...keystrokes: string[]) => {
    const tty = Object.assign(new EventEmitter(), {
      isTTY: true, rawModes: [] as boolean[],
      setRawMode(on: boolean) { tty.rawModes.push(on); return tty; },
      resume() {
        const next = keystrokes.shift();
        if (next !== undefined) setImmediate(() => tty.emit('data', Buffer.from(next, 'latin1')));
        return tty;
      },
      pause() { return tty; },
    });
    return tty;
  };
  const runOn = (args: string[], tty: ReturnType<typeof terminal> | { isTTY: false }) => runMetalsCli(args, {
    env: DISPOSABLE, now: () => NOW, outputAccess: OWNER_ONLY, terminal: tty as unknown as NodeJS.ReadStream,
    io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
  });
  const register = (out: string, source: string, folder: string, from?: string) =>
    ['identity-register', '--registry', at(out), ...(from ? ['--from', at(from)] : []), '--source', source, '--folder', folder];
  const digestArgs = (folder = 'walmart', source = 'walmart') =>
    ['identity-digest', '--registry', at('registry.json'), '--identity-key', at('identity.key'), '--source', source, '--folder', folder];

  it('writes a new owner-only identity key and prints only its code', async () => {
    expect(await run(['identity-key', '--out', at('made.key')])).toBe(0);
    expect(output()).toEqual({ code: 'metals-identity-key-written' });
    const made = fs.readFileSync(at('made.key'), 'latin1');
    expect(made).toMatch(/^[a-p]{64}\n$/);
    expect(stdout + stderr).toBe('');
    expect(await run(['identity-key', '--out', at('again.key')])).toBe(0);
    output();
    expect(fs.readFileSync(at('again.key'), 'latin1')).not.toBe(made);
    // Never over an existing file, and never into a place others can open.
    expect(await run(['identity-key', '--out', at('made.key')])).toBe(1);
    expect(stderr).toBe(REFUSED);
    stderr = '';
    expect(await run(['identity-key', '--out', at('shared.key')], DISPOSABLE, NOT_OWNER_ONLY)).toBe(1);
    expect(output()).toEqual({ code: 'metals-output-not-owner-only' });
    expect(fs.existsSync(at('shared.key'))).toBe(false);
  });

  it('registers folders into a new owner-only registry, a Costco last 4 typed twice on the terminal and never echoed', async () => {
    expect(await run(register('one.json', 'walmart', 'walmart-2'))).toBe(0);
    expect(output()).toEqual({ code: 'metals-identity-registered', source: 'walmart', folder: 'walmart-2', folders: 1 });
    const tty = terminal('111\x7f11\r', '1111\r');
    expect(await runOn(register('two.json', 'costco', 'costco', 'one.json'), tty)).toBe(0);
    expect(stdout + stderr).not.toMatch(VALUES);
    expect(output()).toEqual({ code: 'metals-identity-registered', source: 'costco', folder: 'costco', folders: 2 });
    expect(stderr.split(': ')).toHaveLength(3);
    expect(tty.rawModes).toEqual([true, false, true, false]);
    expect(JSON.parse(fs.readFileSync(at('two.json'), 'utf8'))).toEqual({ format: 'holdr.metals-folder-registry', version: 1, folders: [
      { source: 'walmart', folder: 'walmart-2', identityLast4: null }, { source: 'costco', folder: 'costco', identityLast4: '1111' }] });
    // A folder registered already, entries that differ or aren't four digits, and a cancelled entry write nothing.
    expect(await run(register('bad.json', 'walmart', 'walmart-2', 'two.json'))).toBe(1);
    expect(output()).toEqual({ code: 'metals-identity-already-registered' });
    for (const keystrokes of [['1111\r', '2222\r'], ['11a1\r', '11a1\r'], ['111\r', '111\r']]) {
      expect(await runOn(register('bad.json', 'costco', 'costco'), terminal(...keystrokes))).toBe(1);
      expect(output()).toEqual({ code: 'metals-identity-entry-invalid' });
    }
    expect(await runOn(register('bad.json', 'costco', 'costco'), terminal('11\x03'))).toBe(1);
    expect(output()).toEqual({ code: 'metals-identity-entry-cancelled' });
    expect(await runOn(register('bad.json', 'costco', 'costco'), { isTTY: false })).toBe(1);
    expect(output()).toEqual({ code: 'metals-identity-needs-terminal' });
    expect(fs.existsSync(at('bad.json'))).toBe(false);
    // A folder that isn't its source's is refused as input.
    stderr = '';
    expect(await run(register('bad.json', 'walmart', 'costco'))).toBe(1);
    expect(stderr).toBe(REFUSED);
  });

  it('prints the keyed digest a GO pins for a registered folder, and nothing of the key or the registry', async () => {
    expect(await run(digestArgs())).toBe(0);
    expect(output()).toEqual({ code: 'metals-identity-digest', source: 'walmart', folder: 'walmart', identityDigest: PIN });
    expect(await run(digestArgs('walmart-2'))).toBe(1);
    expect(output()).toEqual({ code: 'metals-identity-unregistered' });
    expect(await run(digestArgs(), DISPOSABLE, NOT_OWNER_ONLY)).toBe(1);
    expect(output()).toEqual({ code: 'metals-identity-input-unusable', reason: 'not-owner-only' });
    stderr = '';
    expect(await run(digestArgs('costco'))).toBe(1);
    expect(stderr).toBe(REFUSED);
  });

  it('imports into a new account only under a pin the registry and the payload both give, before any backup', async () => {
    expect(await install()).toBe(0);
    stdout = '';
    const installed = backups();
    const before = fs.readFileSync(file);
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    const importArgs = (goFile: string, inputs: readonly string[]) =>
      ['import', '--db', file, '--payload', payload, '--go', goFile, '--backup', at(`backup-${randomBytes(4).toString('hex')}.db`), ...inputs];
    const refused = async (goFile: string, inputs: readonly string[], access: OutputAccess = OWNER_ONLY) => {
      expect(await run(importArgs(goFile, inputs), DISPOSABLE, access)).toBe(1);
      return output();
    };
    const existing = { accountId: `mtl-acct-${'a'.repeat(32)}` };
    // The GO's account: a new one needs a pin of 64 letters a–p, an existing one takes none.
    expect(await refused(importGo(payload, { label: 'Walmart account' }), IDENTITY_INPUTS())).toEqual({ code: 'metals-go-invalid' });
    expect(await refused(importGo(payload, { ...existing, identityDigest: PIN }), [])).toEqual({ code: 'metals-go-invalid' });
    expect(await refused(importGo(payload, { label: 'Walmart account', identityDigest: PIN.toUpperCase() }), IDENTITY_INPUTS()))
      .toEqual({ code: 'metals-go-invalid' });
    // The identity inputs come exactly with a pin.
    for (const [account, inputs] of [[NEW_ACCOUNT, []], [NEW_ACCOUNT, IDENTITY_INPUTS().slice(0, 2)], [existing, IDENTITY_INPUTS()]] as const) {
      expect(await run(importArgs(importGo(payload, account), inputs))).toBe(1);
    }
    expect(stderr).toBe(REFUSED.repeat(3));
    stderr = '';
    // A pin the inputs don't give: another key, a registry without the payload's folder, or a pin for another folder.
    write('other.key', keyText(Buffer.alloc(32, 0x5b)));
    expect(await refused(importGo(payload), ['--identity-key', at('other.key'), '--identity-registry', at('registry.json')]))
      .toEqual({ code: 'metals-identity-mismatch' });
    write('moved.json', serializeMetalsFolderRegistry({ folders: [{ ...WALMART_IDENTITY, folder: 'walmart-2' }] }));
    expect(await refused(importGo(payload), ['--identity-key', at('identity.key'), '--identity-registry', at('moved.json')]))
      .toEqual({ code: 'metals-identity-unregistered' });
    const otherFolder = metalsIdentityDigest(IDENTITY_KEY, { ...WALMART_IDENTITY, folder: 'walmart-2' });
    expect(await refused(importGo(payload, { label: 'Walmart account', identityDigest: otherFolder }), IDENTITY_INPUTS()))
      .toEqual({ code: 'metals-identity-mismatch' });
    // Inputs that can't be used, each by its closed reason.
    expect(await refused(importGo(payload), ['--identity-key', at('absent.key'), '--identity-registry', at('registry.json')]))
      .toEqual({ code: 'metals-identity-input-unusable', reason: 'missing' });
    write('short.key', 'abc\n');
    expect(await refused(importGo(payload), ['--identity-key', at('short.key'), '--identity-registry', at('registry.json')]))
      .toEqual({ code: 'metals-identity-input-unusable', reason: 'malformed' });
    write('bad-registry.json', '{"format":"holdr.metals-folder-registry","version":1,"folders":[{}]}');
    expect(await refused(importGo(payload), ['--identity-key', at('identity.key'), '--identity-registry', at('bad-registry.json')]))
      .toEqual({ code: 'metals-identity-input-unusable', reason: 'malformed' });
    expect(await refused(importGo(payload), IDENTITY_INPUTS(), NOT_OWNER_ONLY)).toEqual({ code: 'metals-identity-input-unusable', reason: 'not-owner-only' });
    expect(backups()).toEqual(installed);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // The pin the inputs give imports, creating the account.
    expect(await doImport(payload, importGo(payload))).toBe(0);
    expect(output()).toMatchObject({ code: 'metals-imported', accountCreated: true });
  });

  it('checks the pin before the database is ever opened', async () => {
    const payload = payloadFile('payload.json', [walmartOrder(1)]);
    const absentDb = at('absent.db');
    const goFile = go('import', { inputSha256: sha256(payload), account: NEW_ACCOUNT, databaseRef: digest(path.resolve(absentDb)) });
    write('other.key', keyText(Buffer.alloc(32, 0x5b)));
    const args = (key: string) => ['import', '--db', absentDb, '--payload', payload, '--go', goFile, '--backup', at('backup-absent.db'),
      '--identity-key', key, '--identity-registry', at('registry.json')];
    expect(await run(args(at('other.key')))).toBe(1);
    expect(output()).toEqual({ code: 'metals-identity-mismatch' });
    expect(stderr).toBe('');
    // The pin the inputs give gets as far as the database, which doesn't exist.
    expect(await run(args(at('identity.key')))).toBe(1);
    expect(stderr).toMatch(/^holdr-metals: operation-failed /);
    expect(fs.existsSync(absentDb) || fs.existsSync(at('backup-absent.db'))).toBe(false);
  });
});
