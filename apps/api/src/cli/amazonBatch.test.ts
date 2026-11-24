import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runAmazonCli } from './amazon.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from '../services/amazon/importer.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { rootApproval, syntheticCompleteCapture, syntheticCompleteOrder, syntheticRereadCapture } from '../services/amazon/fixtures.testSupport.js';
import { digest, LEDGER_POLICY_DIGEST, POLICY_DIGEST } from '../services/amazon/policy.js';
import { AMAZON_SCHEMA_DIGEST } from '../services/amazon/schema.js';
import { CUTOVER_SCHEMA_DIGEST } from '../services/guardedCardCommit.js';
import { readCurrentUserSid, restrictToUser } from '../e2e/windowsAcl.js';
import type { OrderObservation } from '../services/amazon/types.js';

// Entirely synthetic: invented order IDs, ASINs, titles, image IDs and amounts.
const IMAGES = ['91SynthAA0L', '91Synth+01L'];
const SECRETS = ['000-0000001-0000001', 'SYNTH00001', 'SYNTH00002', 'Synthetic blue widget', 'Synthetic second widget', ...IMAGES];
let dir: string, file: string, stdout: string, stderr: string, firstCapture: ReturnType<typeof syntheticCompleteCapture>;
let batchClones: string, cloneNumber = 0;
const run = (args: string[]) => runAmazonCli(args, { env: { ...process.env, HOLDR_CONFIG: 'none' },
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } } });
const json = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
  return p;
};
/** The operator's private list of staged capture files. */
const list = (name: string, files: string[]) => json(name, { format: 'holdr.amazon-capture-list', version: 1, captures: files });
/** Each capture as a file of its own, in order. */
const staged = (captures: unknown[]) => captures.map(capture => json(`capture-${digest(capture).slice(0, 12)}.json`, capture));
/** A Root batch GO for `captures`, in order: each GO has its own goId. */
const batchGo = (captures: unknown[], patch: Record<string, unknown> = {}) => json(`batch-go-${randomBytes(6).toString('hex')}.json`, {
  format: 'holdr.amazon-batch-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'import-batch',
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), inputDigests: captures.map(c => digest(c)),
  policyDigest: POLICY_DIGEST, schemaDigest: AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST, ...patch,
});
/** A Root write GO (v2) for one of the existing commands. */
const writeGo = (command: string, input: unknown) => json(`write-go-${randomBytes(6).toString('hex')}.json`, {
  format: 'holdr.amazon-write-go', version: 2, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command,
  databaseRef: digest(path.resolve(file)), inputDigest: digest(input), policyDigest: POLICY_DIGEST, schemaDigest: AMAZON_SCHEMA_DIGEST,
  ledgerPolicyDigest: LEDGER_POLICY_DIGEST,
});
/** One import-batch run, with a new clone in a private directory unless one is given. */
const batch = (listFile: string, goFile: string, backup: string, clone = path.join(batchClones, `clone-${++cloneNumber}.db`)) => {
  stdout = ''; stderr = '';
  return run(['import-batch', '--db', file, '--input', listFile, '--clone', clone, '--backup', backup, '--root-go', goFile]);
};
const preview = (listFile: string, clone: string) => {
  stdout = ''; stderr = '';
  return run(['preview-batch', '--db', file, '--clone', clone, '--input', listFile]);
};
/** A re-read of the synthetic order showing `imageIds`, changed by `change`, with its own run. */
const reread = (run: number, imageIds: Array<string | undefined>, change: (o: OrderObservation) => void = () => undefined) => {
  const order = syntheticCompleteOrder(...imageIds);
  change(order);
  return syntheticRereadCapture(order, run);
};
const refundTotal = (o: OrderObservation) => { o.refundSummary = { currency: 'USD', amountMinor: 300 }; };
function opened<T>(target: string, fn: (db: Database.Database) => T): T {
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}
/** Every table's rows. */
const tables = (target = file) => opened(target, db => Object.fromEntries((db.prepare(`SELECT name FROM sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name`).pluck().all() as string[])
  .map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])));
const display = (target = file) => opened(target, db => db.prepare('SELECT latest_digest FROM amazon_orders').pluck().all());
const captured = (target = file) => opened(target, db => db.prepare('SELECT digest FROM amazon_captures ORDER BY rowid').pluck().all());
/** The batch's own audit rows in the database, in order: what each is, and the GO artifact digest it was made under. */
const batchLog = () => opened(file, db => db.prepare(`SELECT action,before_digest FROM amazon_audit
  WHERE action GLOB 'capture-batch-*' ORDER BY sequence`).all() as Array<{ action: string; before_digest: string }>);
/** The refusals logged in the database: by the goId's digest, with the GO artifact's digest. */
const refusalLog = () => opened(file, db => db.prepare(`SELECT subject_ref,before_digest FROM amazon_audit
  WHERE action='capture-batch-refused' ORDER BY sequence`).all() as Array<{ subject_ref: string; before_digest: string }>);
/** Every table as `before`, but for `audits` audit rows the run appended. */
function unchangedBut(before: ReturnType<typeof tables>, audits: number): void {
  const after = tables();
  expect(after.amazon_audit.length).toBe(before.amazon_audit.length + audits);
  expect({ ...after, amazon_audit: after.amazon_audit.slice(0, before.amazon_audit.length) }).toEqual(before);
}
const goDigestOf = (goFile: string) => digest(JSON.parse(fs.readFileSync(goFile, 'utf8')));
const goIdOf = (goFile: string) => JSON.parse(fs.readFileSync(goFile, 'utf8')).goId as string;
/** A run's attempt and its logged refusal, under one GO artifact. */
const triedAndRefused = (goFile: string) => [{ action: 'capture-batch-attempt', before_digest: goDigestOf(goFile) },
  { action: 'capture-batch-refused', before_digest: goDigestOf(goFile) }];
/** An owner-only directory outside the repository, as the operator provisions for private files (privateFiles.ts). */
function privateDir(name: string): string {
  const out = path.join(fs.realpathSync(dir), name);
  fs.mkdirSync(out);
  if (process.platform === 'win32') restrictToUser(out, readCurrentUserSid());
  else fs.chmodSync(out, 0o700);
  return out;
}
/** A card charge the matcher would weigh against the synthetic order, imported with no Amazon reconcile after it. */
function laterCardRow(): void {
  const repo = new SqliteStateRepo({ file });
  try {
    repo.importCardTransactions({ cardAccountId: readCardInventory(repo.internalGetDb())[0].id, source: 'synthetic',
      parserVersion: 'synthetic@1', rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD',
        amountMinor: 1100, description: 'AMAZON SYNTHETIC LATER', issuerCategory: 'Shopping' }] });
  } finally { repo.close(); }
}

beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-batch-cli-synthetic-'));
  file = path.join(dir, 'finance.db');
  firstCapture = syntheticCompleteCapture();
  // The household's database: one bound card, a 1100 charge, and the synthetic order's first read, linked to it.
  const repo = new SqliteStateRepo({ file }), db = repo.internalGetDb(), setup = privateDir('setup');
  try {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
        description: 'AMAZON SYNTHETIC TOTAL', issuerCategory: 'Shopping' }] });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db));
    await recordBindingProposal(db, proposal, path.join(setup, 'proposal.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(setup, 'approval.db'));
    await importAmazonCapture(db, firstCapture, path.join(setup, 'first.db'));
  } finally { repo.close(); }
  batchClones = privateDir('batch-clones');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('preview-batch (the clone gate)', () => {
  it('previews on a new private clone, in list order, keeping only image-IDs-only captures, and never writes the database', async () => {
    const images = reread(2, [IMAGES[0], IMAGES[1]]);
    const refund = reread(3, [IMAGES[0], IMAGES[1]], refundTotal);
    const repeat = reread(4, [IMAGES[0], IMAGES[1]]);
    const recent = syntheticCompleteCapture(IMAGES[0]);
    const listFile = list('list.json', [...staged([images, refund, repeat, recent]), path.join(dir, 'missing.json')]);
    const clone = path.join(privateDir('clones'), 'clone.db');
    const bytes = fs.readFileSync(file), before = tables(), names = fs.readdirSync(dir);
    expect(await preview(listFile, clone)).toBe(0);
    expect(stderr).toBe('');
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ code: 'batch-previewed', databaseRef: digest(path.resolve(file)), policyDigest: POLICY_DIGEST,
      schemaDigest: AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST, baseline: { settled: true, changed: [] },
      planned: 5, imageIdsOnly: [digest(images)], kinds: { 'order-refund-total': 1 },
      classes: { 'facts-changed': 1, 'image-ids-only': 1, 'no-new-image-ids': 1, refused: 2 } });
    expect(out.captures).toEqual([
      { index: 0, inputDigest: digest(images), class: 'image-ids-only', display: 'replaced',
        imageIds: { added: 2, replaced: 0, removed: 0 }, changed: [], receipt: expect.objectContaining({ newCaptures: 1, newOrders: 0 }) },
      { index: 1, inputDigest: digest(refund), class: 'facts-changed', display: 'replaced',
        imageIds: { added: 0, replaced: 0, removed: 0 }, changed: ['order-refund-total'], receipt: expect.any(Object) },
      { index: 2, inputDigest: digest(repeat), class: 'no-new-image-ids', display: 'replaced',
        imageIds: { added: 0, replaced: 0, removed: 0 }, changed: [], receipt: expect.any(Object) },
      { index: 3, inputDigest: digest(recent), class: 'refused', reason: 'not-a-reread' },
      { index: 4, class: 'refused', reason: 'input-unreadable' },
    ]);
    for (const secret of [...SECRETS, dir, fs.realpathSync(dir)]) expect(stdout).not.toContain(secret);
    // The database is only read: its bytes and rows are unchanged, and at most SQLite's empty reader sidecars appear.
    expect(fs.readFileSync(file)).toEqual(bytes);
    const sidecars = [`${path.basename(file)}-wal`, `${path.basename(file)}-shm`];
    expect(fs.readdirSync(dir).filter(name => !names.includes(name) && !sidecars.includes(name))).toEqual([]);
    expect(fs.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
    expect(tables()).toEqual(before);
    // The clone holds the image-IDs-only capture and nothing the preview refused.
    expect(captured(clone)).toEqual([digest(firstCapture), digest(images)]);
    expect(display(clone)).toEqual([digest(images)]);
    if (process.platform !== 'win32') expect(fs.statSync(clone).mode & 0o777).toBe(0o600);
  });
  it('refuses a clone that exists, is the database or a sidecar, is relative, has no directory or is in the repository', async () => {
    const listFile = list('list.json', staged([reread(2, [IMAGES[0]])]));
    const clones = privateDir('clones'), existing = path.join(clones, 'existing.db');
    fs.writeFileSync(existing, '');
    const inside = path.join(path.dirname(fileURLToPath(import.meta.url)), `synthetic-clone-${process.pid}.db`);
    const bytes = fs.readFileSync(file);
    try {
      for (const clone of [existing, file, `${file}-wal`, `${file}-shm`, `${file}-journal`, 'clone.db',
        path.join(clones, 'missing', 'clone.db'), inside]) {
        expect(await preview(listFile, clone), clone).toBe(1);
        expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
        expect(stdout).toBe('');
      }
      expect(fs.existsSync(inside)).toBe(false);
    } finally { fs.rmSync(inside, { force: true }); }
    expect(fs.readFileSync(existing, 'utf8')).toBe('');
    expect(fs.readdirSync(clones)).toEqual(['existing.db']);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });
  it('reports a database whose next Amazon write would change something, and classifies on the settled clone', async () => {
    laterCardRow();
    const images = reread(2, [IMAGES[0]]);
    expect(await preview(list('list.json', staged([images])), path.join(privateDir('clones'), 'clone.db'))).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.baseline.settled).toBe(false);
    expect(out.baseline.changed).toContain('card-links');
    expect(out.captures).toEqual([expect.objectContaining({ class: 'image-ids-only', changed: [] })]);
    expect(out.imageIdsOnly).toEqual([digest(images)]);
  });
});

describe('commit order', () => {
  it('both commands refuse, before any write, a list whose re-reads of one cursor are not in increasing revision order', async () => {
    const earlier = reread(2, [IMAGES[0]]), later = reread(3, [IMAGES[0], IMAGES[1]]);
    // Another run's read at the same cursor revision is no later.
    const again = syntheticRereadCapture(syntheticCompleteOrder(IMAGES[0], IMAGES[1]), 4, 3);
    const clones = privateDir('clones'), clone = path.join(clones, 'clone.db');
    const backups = privateDir('backups'), bytes = fs.readFileSync(file), names = fs.readdirSync(dir);
    for (const captures of [[later, earlier], [earlier, later, again]]) {
      const listFile = list('list.json', staged(captures)), refusal = { code: 'batch-input-refused', index: captures.length - 1,
        reason: 'revision-order' };
      expect(await preview(listFile, clone)).toBe(1);
      expect(JSON.parse(stdout)).toEqual(refusal);
      expect(await batch(listFile, batchGo(captures), path.join(backups, 'batch.db'))).toBe(1);
      expect(JSON.parse(stdout)).toEqual(refusal);
      expect(stderr).toBe('');
    }
    expect([fs.readdirSync(clones), fs.readdirSync(backups), fs.readdirSync(batchClones)]).toEqual([[], [], []]);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.readdirSync(dir).filter(name => !names.includes(name) && !/^(capture-|list\.json|batch-go-)/.test(name))).toEqual([]);
    // In commit order, the same captures preview.
    expect(await preview(list('list.json', staged([earlier, later])), clone)).toBe(0);
    expect(JSON.parse(stdout).imageIdsOnly).toEqual([digest(earlier), digest(later)]);
  });
});

describe('import-batch', () => {
  it('previews again, then imports the GO\'d re-reads after one backup, each in its own transaction, and spends the GO once', async () => {
    const one = reread(2, [IMAGES[0]]), two = reread(3, [IMAGES[0], IMAGES[1]]);
    const listFile = list('list.json', staged([one, two])), goFile = batchGo([one, two]);
    const backups = privateDir('backups'), backup = path.join(backups, 'batch.db'), before = tables();
    const clone = path.join(batchClones, 'run.db');
    expect(await batch(listFile, goFile, backup, clone)).toBe(0);
    expect(stderr).toBe('');
    const out = JSON.parse(stdout);
    expect(out).toEqual({ code: 'batch-imported', purpose: 'copy-rehearsal', goId: goIdOf(goFile), planned: 2, imported: 2,
      go: 'consumed', preview: { settled: true, changed: [] }, refusal: null, captures: [
        { index: 0, inputDigest: digest(one), code: 'imported', class: 'image-ids-only', display: 'replaced',
          imageIds: { added: 1, replaced: 0, removed: 0 }, changed: [], receipt: expect.objectContaining({ newCaptures: 1, newOrders: 0,
            newMatches: 0, invalidated: 0 }) },
        { index: 1, inputDigest: digest(two), code: 'imported', class: 'image-ids-only', display: 'replaced',
          imageIds: { added: 1, replaced: 0, removed: 0 }, changed: [], receipt: expect.objectContaining({ newCaptures: 1 }) },
      ], release: { format: 'holdr.amazon-imported-captures', version: 1, captureDigests: [digest(one), digest(two)] } });
    for (const secret of [...SECRETS, dir, fs.realpathSync(dir), backups]) expect(stdout).not.toContain(secret);
    // One backup, of the database as it was before the batch. The run's own preview ran on its fresh clone first.
    expect(fs.readdirSync(backups)).toEqual(['batch.db']);
    expect(tables(backup)).toEqual(before);
    expect(captured(clone)).toEqual([digest(firstCapture), digest(one), digest(two)]);
    expect(captured()).toEqual([digest(firstCapture), digest(one), digest(two)]);
    expect(display()).toEqual([digest(two)]);
    expect(refusalLog()).toEqual([]);
    expect(batchLog()).toEqual([{ action: 'capture-batch-attempt', before_digest: goDigestOf(goFile) },
      { action: 'capture-batch-go', before_digest: goDigestOf(goFile) }]);
    // The GO authorized one run: run again, it refuses before any clone or backup, with the GO's closed state.
    const again = path.join(backups, 'again.db'), clones = fs.readdirSync(batchClones);
    expect(await batch(listFile, goFile, again)).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ code: 'batch-go-refused', goId: goIdOf(goFile), go: 'consumed' });
    expect(stderr).toBe('');
    expect([fs.existsSync(again), fs.readdirSync(batchClones)]).toEqual([false, clones]);
  });
  it('stops before writing any capture when its own preview refuses one, logs the refusal with the GO and keeps the GO', async () => {
    const one = reread(2, [IMAGES[0]]), refund = reread(3, [IMAGES[0]], refundTotal), three = reread(4, [IMAGES[0], IMAGES[1]]);
    const listFile = list('list.json', staged([one, refund, three])), goFile = batchGo([one, refund, three]);
    const backups = privateDir('backups'), before = tables();
    expect(await batch(listFile, goFile, path.join(backups, 'batch.db'))).toBe(1);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ code: 'batch-stopped', planned: 3, imported: 0, go: 'unused', preview: { settled: true, changed: [] },
      refusal: { stage: 'preview', index: 1, inputDigest: digest(refund), reason: 'facts-changed', changed: ['order-refund-total'],
        rollback: 'not-started', logged: true },
      release: { format: 'holdr.amazon-imported-captures', version: 1, captureDigests: [] } });
    expect(out.captures).toEqual([
      { index: 0, inputDigest: digest(one), code: 'not-attempted' },
      { index: 1, inputDigest: digest(refund), code: 'refused', reason: 'facts-changed', changed: ['order-refund-total'] },
      { index: 2, inputDigest: digest(three), code: 'not-attempted' },
    ]);
    for (const secret of SECRETS) expect(stdout).not.toContain(secret);
    // Nothing was written but the run's attempt and its refusal, logged with the GO, after the run's one backup.
    unchangedBut(before, 2);
    expect(batchLog()).toEqual(triedAndRefused(goFile));
    expect(refusalLog()).toEqual([{ subject_ref: expect.stringMatching(/^[a-f0-9]{64}$/), before_digest: goDigestOf(goFile) }]);
    expect(fs.readdirSync(backups)).toEqual(['batch.db']);
  });
  it('keeps a GO whose run committed nothing for an unchanged full rerun after a GO\'d reconcile; a committed capture spends it', async () => {
    laterCardRow();
    const one = reread(2, [IMAGES[0]]);
    const listFile = list('list.json', staged([one])), goFile = batchGo([one]);
    const backups = privateDir('backups'), before = tables();
    expect(await batch(listFile, goFile, path.join(backups, 'first.db'))).toBe(1);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ code: 'batch-stopped', imported: 0, go: 'unused', preview: { settled: false },
      refusal: { stage: 'preview', index: null, inputDigest: null, reason: 'baseline-pending', rollback: 'not-started', logged: true },
      captures: [{ index: 0, inputDigest: digest(one), code: 'not-attempted' }], release: { captureDigests: [] } });
    expect(out.preview.changed).toContain('card-links');
    expect(out.refusal.changed).toEqual(out.preview.changed);
    expect(out.goId).toBe(goIdOf(goFile));
    unchangedBut(before, 2);
    // The same goId with other contents is refused before any clone or backup.
    const editedFile = json('edited-go.json', { ...JSON.parse(fs.readFileSync(goFile, 'utf8')), purpose: 'production-import' });
    const clones = fs.readdirSync(batchClones);
    expect(await batch(listFile, editedFile, path.join(backups, 'edited.db'))).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ code: 'batch-go-refused', goId: goIdOf(goFile), go: 'edited' });
    expect(stderr).toBe('');
    expect([fs.existsSync(path.join(backups, 'edited.db')), fs.readdirSync(batchClones)]).toEqual([false, clones]);
    // Root GOes the pending reconcile; the same GO, unchanged, reruns its full preview and the classifier, and imports.
    stdout = '';
    expect(await run(['reconcile', '--db', file, '--backup', path.join(backups, 'reconcile.db'),
      '--root-go', writeGo('reconcile', null)])).toBe(0);
    expect(await batch(listFile, goFile, path.join(backups, 'second.db'))).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'batch-imported', imported: 1, go: 'consumed', preview: { settled: true },
      refusal: null, release: { format: 'holdr.amazon-imported-captures', version: 1, captureDigests: [digest(one)] } });
    expect(display()).toEqual([digest(one)]);
    expect(refusalLog()).toEqual([{ subject_ref: expect.stringMatching(/^[a-f0-9]{64}$/), before_digest: goDigestOf(goFile) }]);
    expect(batchLog()).toEqual([...triedAndRefused(goFile), { action: 'capture-batch-attempt', before_digest: goDigestOf(goFile) },
      { action: 'capture-batch-go', before_digest: goDigestOf(goFile) }]);
    // Its committed capture spent the GO.
    expect(await batch(listFile, goFile, path.join(backups, 'third.db'))).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ code: 'batch-go-refused', goId: goIdOf(goFile), go: 'consumed' });
  });
  it('leaves a GO whose refusal could not be logged unlogged: it never runs again', async () => {
    laterCardRow();
    const writable = new Database(file, { fileMustExist: true });
    try {
      writable.exec(`CREATE TRIGGER synthetic_log_failure BEFORE INSERT ON amazon_audit WHEN NEW.action='capture-batch-refused'
        BEGIN SELECT RAISE(ABORT, 'synthetic log failure'); END;`);
    } finally { writable.close(); }
    const one = reread(2, [IMAGES[0]]), listFile = list('list.json', staged([one])), goFile = batchGo([one]);
    const backups = privateDir('backups'), before = tables();
    expect(await batch(listFile, goFile, path.join(backups, 'first.db'))).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'batch-stopped', imported: 0, go: 'unlogged',
      refusal: { stage: 'preview', reason: 'baseline-pending', logged: false } });
    expect(stdout).not.toContain('synthetic log failure');
    // Only its attempt was written.
    unchangedBut(before, 1);
    expect(batchLog()).toEqual([{ action: 'capture-batch-attempt', before_digest: goDigestOf(goFile) }]);
    // Even with the log mended and the reconcile GO'd, the same GO stays refused: a new GO is needed.
    const fixable = new Database(file, { fileMustExist: true });
    try { fixable.exec('DROP TRIGGER synthetic_log_failure'); } finally { fixable.close(); }
    stdout = '';
    expect(await run(['reconcile', '--db', file, '--backup', path.join(backups, 'reconcile.db'),
      '--root-go', writeGo('reconcile', null)])).toBe(0);
    expect(await batch(listFile, goFile, path.join(backups, 'second.db'))).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ code: 'batch-go-refused', goId: goIdOf(goFile), go: 'unlogged' });
    expect(fs.existsSync(path.join(backups, 'second.db'))).toBe(false);
    expect(await batch(listFile, batchGo([one]), path.join(backups, 'third.db'))).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'batch-imported', imported: 1, go: 'consumed' });
  });
  // The independent review's real-CLI repros at 33607746 (reviewer 5b01e72f): each exited 0 there, committed its
  // prohibited change and released the capture. Each is now refused with nothing committed but its logged refusal.
  it.each<[string, (db: Database.Database) => void, { index: number | null; reason: string; changed: string }]>([
    ['a missing Amazon table the write would install', db => db.exec('DROP TABLE amazon_line_joins; DROP TABLE amazon_shipments;'),
      { index: null, reason: 'baseline-pending', changed: 'schema' }],
    ['a change past an embedded NUL in another table', db => {
      db.exec('CREATE TABLE synthetic_side(v TEXT)');
      db.prepare('INSERT INTO synthetic_side VALUES(?)').run('synthetic\0before');
      db.exec(`CREATE TRIGGER synthetic_guard_probe AFTER UPDATE ON amazon_orders BEGIN
        UPDATE synthetic_side SET v='synthetic'||char(0)||'after'; END;`);
    }, { index: 0, reason: 'facts-changed', changed: 'non-amazon' }],
    ['a changed price in a new item row', db => db.exec(`CREATE TRIGGER synthetic_guard_probe AFTER INSERT ON amazon_items BEGIN
      UPDATE amazon_items SET data_json=json_set(data_json,'$.unitPrice.amountMinor',123) WHERE ref=NEW.ref; END;`),
    { index: 0, reason: 'facts-changed', changed: 'history-changed' }],
    // The residual repros at 878e1c99, each of which also exited 0 and released its capture there.
    ['a duplicate date put first in the display', db => db.exec(`CREATE TRIGGER synthetic_guard_probe
      AFTER UPDATE OF data_json ON amazon_orders BEGIN
      UPDATE amazon_orders SET data_json='{"date":"2024-01-01",'||substr(NEW.data_json,2) WHERE ref=NEW.ref; END;`),
    { index: 0, reason: 'facts-changed', changed: 'order-other' }],
    ['an extra kept-details audit', db => db.exec(`CREATE TRIGGER synthetic_guard_probe AFTER INSERT ON amazon_items BEGIN
      INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
      VALUES('header-only-kept-details',NULL,'synthetic-before','synthetic-after','synthetic-policy','synthetic-time'); END;`),
    { index: 0, reason: 'facts-changed', changed: 'audit-other' }],
    ['no display audit', db => db.exec(`CREATE TRIGGER synthetic_guard_probe AFTER INSERT ON amazon_audit
      WHEN NEW.action='order-observation' BEGIN DELETE FROM amazon_audit WHERE sequence=NEW.sequence; END;`),
    { index: 0, reason: 'facts-changed', changed: 'audit-other' }],
    ['a moved rowid in another table', db => db.exec(`CREATE TABLE synthetic_side(v TEXT); INSERT INTO synthetic_side VALUES('synthetic');
      CREATE TRIGGER synthetic_guard_probe AFTER UPDATE ON amazon_orders BEGIN UPDATE synthetic_side SET rowid=rowid+1; END;`),
    { index: 0, reason: 'facts-changed', changed: 'non-amazon' }],
  ])('refuses the review repro with %s, committing nothing but its logged refusal', async (_, install, expected) => {
    const writable = new Database(file, { fileMustExist: true });
    try { install(writable); } finally { writable.close(); }
    const one = reread(2, [IMAGES[0]]), before = tables();
    expect(await batch(list('list.json', staged([one])), batchGo([one]), path.join(privateDir('backups'), 'batch.db'))).toBe(1);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ code: 'batch-stopped', imported: 0, go: 'unused',
      refusal: { stage: 'preview', index: expected.index, reason: expected.reason, logged: true }, release: { captureDigests: [] } });
    expect(out.refusal.changed).toContain(expected.changed);
    unchangedBut(before, 2);
  });
  // Root (01:30Z), after #222: a display stored in any form but the importer's exact JSON refuses. At #222's merge, each
  // of these committed and released its capture as image-IDs-only (reviewer 5b01e72f, at e04b6ab1).
  it.each<[string, (text: string) => string]>([
    ['an amount written as 1100.0', text => text.replace(/("amountMinor":)(-?\d+)/g, '$1$2.0')],
    ['whitespace', text => JSON.stringify(JSON.parse(text), null, 1)],
    ['another key order', text => {
      const { date, ...rest } = JSON.parse(text) as Record<string, unknown>;
      return JSON.stringify({ ...rest, date });
    }],
  ])('refuses a re-read over a display stored with %s, committing nothing but its logged refusal', async (_, transform) => {
    const writable = new Database(file, { fileMustExist: true });
    try {
      const text = writable.prepare('SELECT data_json FROM amazon_orders').pluck().get() as string;
      expect(transform(text)).not.toBe(text);
      writable.prepare('UPDATE amazon_orders SET data_json=?').run(transform(text));
    } finally { writable.close(); }
    const one = reread(2, [IMAGES[0]]), before = tables();
    expect(await batch(list('list.json', staged([one])), batchGo([one]), path.join(privateDir('backups'), 'batch.db'))).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'batch-stopped', imported: 0, go: 'unused',
      refusal: { stage: 'preview', index: 0, reason: 'facts-changed', changed: ['order-stored-form'], logged: true },
      captures: [{ index: 0, code: 'refused', reason: 'facts-changed', changed: ['order-stored-form'] }],
      release: { captureDigests: [] } });
    unchangedBut(before, 2);
  });
  it('refuses a malformed batch GO, and either GO format for the other command, before any clone or backup', async () => {
    const one = reread(2, [IMAGES[0]]), two = reread(3, [IMAGES[0], IMAGES[1]]);
    const listFile = list('list.json', staged([one, two])), backups = privateDir('backups'), backup = path.join(backups, 'batch.db');
    const digests = [digest(one), digest(two)];
    const patches: Array<Record<string, unknown>> = [
      { format: 'holdr.amazon-write-go' }, { version: 2 }, { version: '1' }, { authority: 'root' }, { decision: 'NO-GO' },
      { purpose: 'production-backfill' }, { purpose: ['copy-rehearsal'] }, { command: 'import' }, { goId: 'G'.repeat(32) },
      { goId: 'a'.repeat(31) }, { goId: undefined }, { databaseRef: digest(path.resolve(dir, 'other.db')) },
      { inputDigests: [] }, { inputDigests: digests.join(',') }, { inputDigests: [digests[0], digests[0]] },
      { inputDigests: [digests[0], 'f'.repeat(63)] }, { inputDigests: Array.from({ length: 51 }, (_, n) => digest(n)) },
      { policyDigest: '0'.repeat(64) }, { schemaDigest: CUTOVER_SCHEMA_DIGEST }, { ledgerPolicyDigest: '0'.repeat(64) },
      { extra: true },
    ];
    for (const patch of patches) {
      expect(await batch(listFile, batchGo([one, two], patch), backup), JSON.stringify(patch)).toBe(1);
      expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
      expect(stdout).toBe('');
    }
    // A backup or clone that is the database or one of its reserved sidecars, the same file for both, or a clone in the
    // repository, is refused before the database is opened.
    const inside = path.join(path.dirname(fileURLToPath(import.meta.url)), `synthetic-batch-clone-${process.pid}.db`);
    try {
      for (const [target, clone] of [...[file, `${file}-wal`, `${file}-shm`, `${file}-journal`].flatMap(reserved =>
        [[reserved, undefined], [backup, reserved]]), [backup, backup], [backup, inside]] as Array<[string, string | undefined]>) {
        expect(await batch(listFile, batchGo([one, two]), target, clone), `${target} ${clone}`).toBe(1);
        expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
        expect(stdout).toBe('');
      }
      expect(fs.existsSync(inside)).toBe(false);
    } finally { fs.rmSync(inside, { force: true }); }
    // No GO or no clone at all, or a write GO, is refused; and a batch GO never authorizes the single import.
    stdout = ''; stderr = '';
    expect(await run(['import-batch', '--db', file, '--input', listFile, '--clone', path.join(batchClones, 'x.db'),
      '--backup', backup])).toBe(1);
    expect(await run(['import-batch', '--db', file, '--input', listFile, '--backup', backup,
      '--root-go', batchGo([one, two])])).toBe(1);
    expect(await batch(listFile, writeGo('import-batch', one), backup)).toBe(1);
    stdout = ''; stderr = '';
    expect(await run(['import', '--db', file, '--input', staged([one])[0], '--backup', backup, '--root-go', batchGo([one])])).toBe(1);
    expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
    expect([fs.readdirSync(backups), fs.readdirSync(batchClones)]).toEqual([[], []]);
    expect(captured()).toEqual([digest(firstCapture)]);
  });
  it('refuses a capture list that does not match its GO before opening the database, naming only the place', async () => {
    const one = reread(2, [IMAGES[0]]), two = reread(3, [IMAGES[0], IMAGES[1]]), recent = syntheticCompleteCapture(IMAGES[0]);
    const invalid = reread(4, [IMAGES[0]]);
    (invalid.staging.orders[0].items[0] as { imageId?: string }).imageId = 'not-an-image-id';
    const backups = privateDir('backups'), backup = path.join(backups, 'batch.db'), before = tables();
    const cases: Array<[string[], unknown[], Record<string, unknown> | null]> = [
      [staged([two, one]), [one, two], { index: 0, reason: 'digest-mismatch' }],
      [staged([one, recent]), [one, recent], { index: 1, reason: 'not-a-reread' }],
      [staged([invalid]), [invalid], { index: 0, reason: 'input-invalid' }],
      [[path.join(dir, 'missing.json')], [one], { index: 0, reason: 'input-unreadable' }],
      [staged([one]), [one, two], null],
    ];
    for (const [files, pinned, refusal] of cases) {
      expect(await batch(list('list.json', files), batchGo(pinned), backup)).toBe(1);
      if (refusal) {
        expect(JSON.parse(stdout)).toEqual({ code: 'batch-input-refused', ...refusal });
        expect(stderr).toBe('');
      } else expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
    }
    // More than a batch's 50 captures refuses whole.
    const many = Array.from({ length: 51 }, (_, n) => reread(10 + n, [IMAGES[0]]));
    expect(await batch(list('list.json', staged(many)), batchGo(many.slice(0, 50)), backup)).toBe(1);
    expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
    expect([fs.readdirSync(backups), fs.readdirSync(batchClones)]).toEqual([[], []]);
    expect(tables()).toEqual(before);
  });
  it('refuses JSON input that repeats a key: a capture by its place, a capture list or a GO whole', async () => {
    const one = reread(2, [IMAGES[0]]), two = reread(3, [IMAGES[0], IMAGES[1]]);
    // The second capture with a key repeated first: JavaScript reads the capture the GO pins, SQLite the repeated key.
    const ambiguous = (name: string, value: unknown, repeated: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `{${repeated},${JSON.stringify(value).slice(1)}`, { mode: 0o600 });
      return file;
    };
    const twice = ambiguous('capture-twice.json', two, '"continuation":null');
    expect(digest(JSON.parse(fs.readFileSync(twice, 'utf8')))).toBe(digest(two));
    const listFile = list('list.json', [...staged([one]), twice]), backups = privateDir('backups');
    expect(await batch(listFile, batchGo([one, two]), path.join(backups, 'batch.db'))).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ code: 'batch-input-refused', index: 1, reason: 'duplicate-keys' });
    expect(stderr).toBe('');
    expect(await preview(listFile, path.join(privateDir('clones'), 'clone.db'))).toBe(0);
    expect(JSON.parse(stdout).captures[1]).toEqual({ index: 1, class: 'refused', reason: 'duplicate-keys' });
    const plain = list('plain.json', staged([one]));
    for (const [listed, go] of [[ambiguous('list-twice.json', JSON.parse(fs.readFileSync(plain, 'utf8')), '"captures":[]'), batchGo([one])],
      [plain, ambiguous('go-twice.json', JSON.parse(fs.readFileSync(batchGo([one]), 'utf8')), '"decision":"NO-GO"')]]) {
      expect(await batch(listed, go, path.join(backups, 'next.db'))).toBe(1);
      expect([stdout, stderr]).toEqual(['', 'amazon: input-refused HoldrRefusal\n']);
    }
    expect([fs.readdirSync(backups), fs.readdirSync(batchClones)]).toEqual([[], []]);
    expect(captured()).toEqual([digest(firstCapture)]);
  });
  it('lists both commands in its usage', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toContain('preview-batch --db DB --clone NEW_CLONE --input CAPTURE_LIST');
    expect(stdout).toContain('import-batch --db DB --input CAPTURE_LIST --clone NEW_CLONE --backup NEW_FILE --root-go BATCH_ARTIFACT');
  });
});
