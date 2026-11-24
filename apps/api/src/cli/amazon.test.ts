import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runAmazonCli } from './amazon.js';
import { syntheticCapture, syntheticBackfillCapture } from '../services/amazon/fixtures.testSupport.js';
import { digest, POLICY_DIGEST, LEDGER_POLICY_DIGEST } from '../services/amazon/policy.js';
import { AMAZON_SCHEMA_DIGEST, hasAmazonSchema } from '../services/amazon/schema.js';
import { makeAgentReview } from '../services/amazon/categorization.js';
import { productKey, projectProducts } from '../services/amazon/products.js';
import { compareObservation } from '../services/amazon/importer.js';
import { categoryKeyAdoptions } from '../services/amazon/ownerDecisions.js';
import { getAmazonOrder, listAmazonOrders } from '../services/amazon/readModel.js';
import { CUTOVER_SCHEMA_DIGEST, hasCutoverReceiptSchema } from '../services/guardedCardCommit.js';
import { readCurrentUserSid, restrictToUser } from '../e2e/windowsAcl.js';

let dir: string, file: string, stdout: string, stderr: string;
const json = (name: string, value: unknown) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 }); return p; };
const run = (args: string[]) => runAmazonCli(args, { env: { ...process.env, HOLDR_CONFIG: 'none' },
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } } });
const go = (command: string, input: unknown) => json(`go-${command}.json`, {
  format: 'holdr.amazon-write-go', version: 2, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal',
  command, databaseRef: digest(path.resolve(file)), inputDigest: digest(input), policyDigest: POLICY_DIGEST,
  schemaDigest: command === 'migrate-cutover' ? CUTOVER_SCHEMA_DIGEST : AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST,
});
/** Every file in the test directory, by name and content digest: a refusal leaves no backup, journal or change behind. */
const files = () => Object.fromEntries(fs.readdirSync(dir).sort().map(name =>
  [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
beforeEach(() => {
  stdout = ''; stderr = '';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-cli-synthetic-'));
  file = path.join(dir, 'finance.db');
  new SqliteStateRepo({ file }).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
/** An owner-only directory outside the repository, as the operator provisions for private outputs (privateFiles.ts). */
function privateDir(name: string): string {
  const out = path.join(fs.realpathSync(dir), name);
  fs.mkdirSync(out);
  if (process.platform === 'win32') restrictToUser(out, readCurrentUserSid());
  else fs.chmodSync(out, 0o700);
  return out;
}
/** One synthetic card and its posted rows, in the existing database. */
function seedCards(rows: Array<{ amountMinor: number; description: string; issuerCategory: string }>): void {
  const repo = new SqliteStateRepo({ file });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'alex', currency: 'USD', nickname: 'Synthetic card' });
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: rows.map(row => ({ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD', ...row })) });
  repo.close();
}
/** The synthetic order's one line, read without (null) or with its ASIN. */
function learnedRead(n: number, asin: string | null) {
  const c = syntheticCapture();
  c.staging.runId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  c.staging.orders[0].items[0].itemId = asin;
  return c;
}
async function importRead(c: ReturnType<typeof syntheticCapture>, n: number) {
  stdout = '';
  expect(await run(['import', '--db', file, '--input', json(`capture-${n}.json`, c), '--backup', path.join(dir, `import-${n}.db`),
    '--root-go', go('import', c)])).toBe(0);
  return JSON.parse(stdout) as { holds: Array<{ reason: string; count: number }> };
}
function opened<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
/** Every Amazon and card table, to compare the database before and after a command. */
const tables = () => opened(db => Object.fromEntries((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
  AND (name LIKE 'amazon%' OR name LIKE 'card%') ORDER BY name`).pluck().all() as string[])
  .map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])));
/** A GO'd `review` of a file through the CLI, with a new backup: its exit code. */
async function reviewFile(input: string, n: string): Promise<number> {
  stdout = ''; stderr = '';
  return run(['review', '--db', file, '--input', input, '--backup', path.join(dir, `review-${n}.db`),
    '--root-go', go('review', JSON.parse(fs.readFileSync(input, 'utf8')))]);
}

describe('local operator CLI gates and privacy', () => {
  it('explicit cutover schema install requires its own command/digest and backs up before DDL without installing Amazon',async()=>{
    const backup=path.join(dir,'cutover-before.db');
    const args=['migrate-cutover','--db',file,'--backup',backup,'--root-go'];
    expect(await run([...args,go('migrate',null)])).toBe(1);
    expect(fs.existsSync(backup)).toBe(false);
    const auth=go('migrate-cutover',null);
    const a=JSON.parse(fs.readFileSync(auth,'utf8'));a.schemaDigest=AMAZON_SCHEMA_DIGEST;json('wrong-cutover.json',a);
    expect(await run([...args,path.join(dir,'wrong-cutover.json')])).toBe(1);
    expect(fs.existsSync(backup)).toBe(false);
    stdout='';
    expect(await run([...args,auth])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({code:'cutover-schema-ready',schemaDigest:CUTOVER_SCHEMA_DIGEST});
    const before=new Database(backup,{readonly:true}),current=new Database(file,{readonly:true});
    try{
      expect(hasCutoverReceiptSchema(before)).toBe(false);
      expect(hasCutoverReceiptSchema(current)).toBe(true);
      expect(hasAmazonSchema(current)).toBe(false);
      expect(current.prepare('SELECT count(*) AS n FROM card_transactions').get()).toEqual({n:0});
    }finally{before.close();current.close();}
    expect(await run([...args,auth])).toBe(1);
  });
  it('inspect is read-only and prints counts/coverage, never native IDs or item titles', async () => {
    const capture = syntheticCapture();
    const before = fs.readFileSync(file);
    expect(await run(['inspect', '--input', json('capture.json', capture)])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'validated-not-imported', version: 3, orders: 1 });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(stdout).not.toContain(capture.staging.orders[0].orderId);
    expect(stdout).not.toContain(capture.staging.orders[0].items[0].title);
  });
  it('requires independently supplied Root GO pinned to command/database/input/policy before opening writer', async () => {
    const c = syntheticCapture(), capture = json('capture.json', c), backup = path.join(dir, 'backup.db');
    expect(await run(['import', '--db', file, '--input', capture, '--backup', backup])).toBe(1);
    expect(fs.existsSync(backup)).toBe(false);
    const auth = go('import', c);
    const a = JSON.parse(fs.readFileSync(auth, 'utf8')); a.databaseRef = 'wrong';
    fs.writeFileSync(auth, JSON.stringify(a));
    expect(await run(['import', '--db', file, '--input', capture, '--backup', backup, '--root-go', auth])).toBe(1);
    const db = new Database(file, { readonly: true }); expect(hasAmazonSchema(db)).toBe(false); db.close();
  });
  it('imports into an existing synthetic finance database with a real pre-write backup and zero repeat records', async () => {
    const c = syntheticCapture(), capture = json('capture.json', c), auth = go('import', c);
    const args = ['import', '--db', file, '--input', capture, '--root-go', auth, '--backup'];
    expect(await run([...args, path.join(dir, 'backup-one.db')])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ newCaptures: 1, newOrders: 1, newMatches: 0, held: 1 });
    stdout = '';
    expect(await run([...args, path.join(dir, 'backup-two.db')])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ newCaptures: 0, newOrders: 0, newObservations: 0, newMatches: 0 });
    expect(stderr).toBe('');
  });
  it('validates private backfill envelopes without exposing cursors and pins GO to the entire original input', async () => {
    const c = syntheticBackfillCapture(), input = json('backfill.json', c), auth = go('import', c);
    const before = fs.readFileSync(file);
    expect(await run(['inspect', '--input', input])).toBe(0);
    expect(fs.readFileSync(file)).toEqual(before);
    c.continuation.after.id = '00000000-0000-4000-8000-000000000098';
    json('backfill.json', c);
    const backup = path.join(dir, 'backfill-backup.db');
    expect(await run(['import', '--db', file, '--input', input, '--root-go', auth, '--backup', backup])).toBe(1);
    expect(fs.existsSync(backup)).toBe(false);
    expect(await run(['import', '--db', file, '--input', input, '--root-go', go('import', c), '--backup', backup])).toBe(0);
    expect(stdout + stderr).not.toContain(c.continuation.after.id);
    expect(stdout + stderr).not.toContain('continuation');
    const current = new Database(file, { readonly: true });
    try { expect(current.prepare('SELECT capture_mode FROM amazon_capture_runs').pluck().get()).toBe('backfill'); }
    finally { current.close(); }
  });
  it('schema-only migration is backed up and refuses overwrite on repeat', async () => {
    const auth = go('migrate', null), backup = path.join(dir, 'migration-backup.db');
    const args = ['migrate', '--db', file, '--root-go', auth, '--backup', backup];
    expect(await run(args)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'schema-ready', schemaDigest: AMAZON_SCHEMA_DIGEST, ledgerPolicyDigest: LEDGER_POLICY_DIGEST });
    const current = new Database(file, { readonly: true });
    for (const table of ['amazon_capture_runs', 'amazon_ledger_candidates', 'amazon_ledger_matches']) {
      expect(current.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    current.close();
    const old = new Database(backup, { readonly: true }); expect(hasAmazonSchema(old)).toBe(false); old.close();
    expect(await run(args)).toBe(1);
  });
  it('migrates populated 22-table captures without activating their existing ledger observations', async () => {
    const c = syntheticCapture();
    c.staging.payments.push({
      date: '2026-09-03', money: { currency: 'USD', amountMinor: 1100 }, kind: 'charge', status: 'completed',
      method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [c.staging.orders[0].orderId],
      identity: 'native-row', provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal: 0 },
    });
    c.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
    expect(await run(['import', '--db', file, '--input', json('capture.json', c), '--root-go', go('import', c),
      '--backup', path.join(dir, 'before-import.db')])).toBe(0);
    const legacy = new Database(file);
    legacy.exec(`DROP TABLE amazon_ledger_matches; DROP TABLE amazon_ledger_candidates; DROP TABLE amazon_capture_runs;
      DROP TABLE amazon_refund_event_members; DROP TABLE amazon_refund_events; DROP TABLE amazon_proof_predecessors`); // STEP 9 integration (revocation)
    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%' ORDER BY name")
      .pluck().all() as string[];
    expect(tables).toHaveLength(22);
    const prior = tables.map(table => legacy.prepare(`SELECT * FROM ${table}`).all());
    expect(legacy.prepare("SELECT count(*) FROM amazon_observations WHERE family='payment'").pluck().get()).toBe(1);
    legacy.close();
    stdout = '';
    const backup = path.join(dir, 'before-migration.db');
    expect(await run(['migrate', '--db', file, '--root-go', go('migrate', null), '--backup', backup])).toBe(0);
    const current = new Database(file, { readonly: true }), saved = new Database(backup, { readonly: true });
    try {
      // STEP 9 integration (revocation)
      expect(current.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%'").pluck().get()).toBe(28);
      expect(saved.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'amazon_%'").pluck().get()).toBe(22);
      for (const connection of [current, saved]) {
        expect(tables.map(table => connection.prepare(`SELECT * FROM ${table}`).all())).toEqual(prior);
      }
      for (const table of ['amazon_capture_runs', 'amazon_ledger_candidates', 'amazon_ledger_matches',
        'amazon_refund_events', 'amazon_refund_event_members', 'amazon_proof_predecessors']) {
        expect(current.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
      }
    } finally { current.close(); saved.close(); }
  });
  it.each(['legacy', 'wrong-schema', 'wrong-ledger-policy'])('refuses %s GO before backup or schema writes', async variant => {
    const c = syntheticCapture(), auth = go('import', c);
    const a = JSON.parse(fs.readFileSync(auth, 'utf8'));
    if (variant === 'legacy') { a.version = 1; delete a.schemaDigest; delete a.ledgerPolicyDigest; }
    if (variant === 'wrong-schema') a.schemaDigest = digest('wrong schema');
    if (variant === 'wrong-ledger-policy') a.ledgerPolicyDigest = digest('wrong policy');
    fs.writeFileSync(auth, JSON.stringify(a));
    const backup = path.join(dir, 'must-not-exist.db');
    expect(await run(['import', '--db', file, '--input', json('capture.json', c), '--root-go', auth, '--backup', backup])).toBe(1);
    expect(fs.existsSync(backup)).toBe(false);
    const current = new Database(file, { readonly: true }); expect(hasAmazonSchema(current)).toBe(false); current.close();
  });
  it('never echoes malformed JSON, private file paths or submitted errors', async () => {
    const privateMarker = 'SYNTHETIC_PRIVATE_SENTINEL';
    const p = path.join(dir, `${privateMarker}.json`);
    fs.writeFileSync(p, `{${privateMarker}`);
    expect(await run(['inspect', '--input', p])).toBe(1);
    expect(stdout + stderr).not.toContain(privateMarker);
    expect(stdout + stderr).not.toContain(dir);
  });
  it('applies private agent review only through pinned Root GO and a fresh backup without changing card rows', async () => {
    const repo = new SqliteStateRepo({ file });
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'alex', currency: 'USD', nickname: 'Synthetic card' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [{
      transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
      description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping',
    }] });
    const rows = repo.internalGetDb().prepare('SELECT * FROM card_transactions').all(); repo.close();
    const capture = syntheticCapture();
    expect(await run(['import', '--db', file, '--input', json('capture.json', capture), '--backup', path.join(dir, 'import.db'),
      '--root-go', go('import', capture)])).toBe(0);
    const products = projectProducts([capture]);
    const review = makeAgentReview(products, ['Shopping'], [{ productKey: productKey(products.products[0]), category: 'Shopping',
      confidence: 0.8, source: 'agent', rationale: 'categorized from product title' }]);
    const input = json('review.json', review), backup = path.join(dir, 'review.db');
    const args = ['review', '--db', file, '--input', input, '--backup', backup];
    expect(await run(args)).toBe(1);
    expect(fs.existsSync(backup)).toBe(false);
    expect(await run([...args, '--root-go', go('review', review)])).toBe(0);
    const db = new Database(file, { readonly: true });
    expect(db.prepare('SELECT category,confidence,source,rationale FROM amazon_agent_categories').all())
      .toEqual([{ category: 'Shopping', confidence: 0.8, source: 'agent', rationale: 'categorized from product title' }]);
    expect(db.prepare('SELECT * FROM card_transactions').all()).toEqual(rows);
    db.close();
    expect(stdout + stderr).not.toContain(capture.staging.orders[0].items[0].title);
  });
  it('refuses a GO whose fields match only once coerced before any backup, and never opens a database it names', async () => {
    const c = syntheticCapture(), input = json('capture.json', c), backup = path.join(dir, 'never.db');
    const auth = JSON.parse(fs.readFileSync(go('import', c), 'utf8')) as Record<string, unknown>;
    const coerced: Array<Record<string, unknown>> = [
      { purpose: ['copy-rehearsal'] }, { purpose: [['production-import']] }, { purpose: { purpose: 'copy-rehearsal' } },
      { purpose: null }, { purpose: 0 }, { version: '2' }, { version: [2] }, { format: ['holdr.amazon-write-go'] },
      { authority: ['Root'] }, { decision: ['GO'] }, { command: ['import'] }, { databaseRef: [auth.databaseRef] },
      { inputDigest: [auth.inputDigest] }, { policyDigest: [POLICY_DIGEST] }, { schemaDigest: [AMAZON_SCHEMA_DIGEST] },
      { ledgerPolicyDigest: [LEDGER_POLICY_DIGEST] },
    ];
    const gos = coerced.map((patch, n) => json(`go-coerced-${n}.json`, { ...auth, ...patch }));
    const before = files();
    for (const [n, goFile] of gos.entries()) {
      stderr = '';
      expect(await run(['import', '--db', file, '--input', input, '--backup', backup, '--root-go', goFile]), JSON.stringify(coerced[n])).toBe(1);
      expect(stderr, JSON.stringify(coerced[n])).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(files()).toEqual(before);
    // Pinned to a database that doesn't exist, a coerced purpose is a refusal, not a failed open, and creates nothing.
    const absent = path.join(dir, 'absent.db');
    for (const purpose of [['copy-rehearsal'], { purpose: 'production-import' }, null, 1]) {
      stderr = '';
      expect(await run(['import', '--db', absent, '--input', input, '--backup', backup, '--root-go',
        json('go-absent.json', { ...auth, purpose, databaseRef: digest(path.resolve(absent)) })])).toBe(1);
      expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(fs.readdirSync(dir).filter(name => name.startsWith('absent.db') || name.startsWith('never.db'))).toEqual([]);
    // The same GO, uncoerced, still imports.
    expect(await run(['import', '--db', file, '--input', input, '--backup', backup, '--root-go', json('go-valid.json', auth)])).toBe(0);
  });
  it('refuses a review whose fields match only once coerced before any backup, even under a GO pinned to it', async () => {
    const c = syntheticCapture();
    expect(await run(['import', '--db', file, '--input', json('capture.json', c), '--backup', path.join(dir, 'import.db'),
      '--root-go', go('import', c)])).toBe(0);
    const reader = new Database(file, { readonly: true });
    const orderRef = reader.prepare('SELECT ref FROM amazon_orders').pluck().get() as string;
    const itemRef = reader.prepare('SELECT ref FROM amazon_items').pluck().get() as string;
    reader.close();
    const pinned = (review: unknown, name: string) => {
      const goFile = path.join(dir, `go-${name}.json`);
      fs.renameSync(go('review', review), goFile);
      return ['review', '--db', file, '--input', json(`${name}.json`, review), '--root-go', goFile];
    };
    const reviews: unknown[] = [
      { kind: 'beneficiary', orderRef, beneficiary: ['alex'] }, { kind: 'beneficiary', orderRef, beneficiary: [['joint']] },
      { kind: 'beneficiary', orderRef, beneficiary: { beneficiary: 'casey' } }, { kind: 'beneficiary', orderRef, beneficiary: 1 },
      { kind: 'beneficiary', orderRef: [orderRef], beneficiary: 'alex' }, { kind: ['beneficiary'], orderRef, beneficiary: 'alex' },
      { kind: 'mapping', sourceCategory: 'Shopping', category: ['Shopping'], reviewed: true },
      { kind: 'mapping', sourceCategory: 'Shopping', category: 'Shopping', reviewed: 'true' },
      { kind: 'item-override', itemRef: [itemRef], category: 'Shopping' },
    ];
    const runs = reviews.map((review, n) => pinned(review, `review-coerced-${n}`));
    const backup = path.join(dir, 'never.db'), before = files();
    for (const [n, args] of runs.entries()) {
      stderr = '';
      expect(await run([...args, '--backup', backup]), JSON.stringify(reviews[n])).toBe(1);
      expect(stderr, JSON.stringify(reviews[n])).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(files()).toEqual(before);
    // The same review, uncoerced, still applies.
    expect(await run([...pinned({ kind: 'beneficiary', orderRef, beneficiary: 'alex' }, 'review-valid'), '--backup', backup])).toBe(0);
    const db = new Database(file, { readonly: true });
    try { expect(db.prepare('SELECT beneficiary FROM amazon_orders WHERE ref=?').pluck().get(orderRef)).toBe('alex'); }
    finally { db.close(); }
  });
  it('refuses a capture whose fields match only once coerced before any backup, even under a GO pinned to it', async () => {
    const coerced: Array<(c: ReturnType<typeof syntheticCapture>) => void> = [
      c => { Object.assign(c.staging, { mode: ['recent'] }); },
      c => { Object.assign(c.staging.orders[0], { tenderCoverage: ['single-card-proven'] }); },
      c => { Object.assign(c.staging.orders[0].summary![1], { kind: ['shipping'] }); },
      c => { Object.assign(c.staging.orders[0].paymentMethods![0], { network: ['visa'] }); },
      c => { Object.assign(c.staging.orders[0], { tenderCoverage: 'unknown', paymentMethods: [{ kind: ['balance'], network: 'unknown', last4: null }] }); },
    ];
    const runs = coerced.map((mutate, n) => {
      const c = syntheticCapture();
      mutate(c);
      const goFile = path.join(dir, `go-capture-${n}.json`);
      fs.renameSync(go('import', c), goFile);
      return ['import', '--db', file, '--input', json(`capture-${n}.json`, c), '--root-go', goFile];
    });
    const backup = path.join(dir, 'never.db'), before = files();
    for (const [n, args] of runs.entries()) {
      stderr = '';
      expect(await run([...args, '--backup', backup]), String(n)).toBe(1);
      expect(stderr, String(n)).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(files()).toEqual(before);
  });
  it('refuses a malformed agent classification before any backup, even under a GO pinned to it', async () => {
    const repo = new SqliteStateRepo({ file });
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'alex', currency: 'USD', nickname: 'Synthetic card' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [{
      transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
      description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping',
    }] });
    repo.close();
    const capture = syntheticCapture();
    expect(await run(['import', '--db', file, '--input', json('capture.json', capture), '--backup', path.join(dir, 'import.db'),
      '--root-go', go('import', capture)])).toBe(0);
    const products = projectProducts([capture]);
    const valid = makeAgentReview(products, ['Shopping'], [{ productKey: productKey(products.products[0]), category: 'Shopping',
      confidence: 0.8, source: 'agent', rationale: 'categorized from product title' }]);
    const entry = valid.entries[0];
    const pinned = (review: unknown, name: string) => {
      const goFile = path.join(dir, `go-${name}.json`);
      fs.renameSync(go('review', review), goFile);
      return ['review', '--db', file, '--input', json(`${name}.json`, review), '--root-go', goFile];
    };
    const malformed: unknown[] = [
      { kind: 'agent-classification' }, { ...valid, productsDigest: [valid.productsDigest] }, { ...valid, productsDigest: null },
      { ...valid, productsDigest: 1 }, { ...valid, productsDigest: valid.productsDigest.toUpperCase() },
      { ...valid, categoriesDigest: [valid.categoriesDigest] }, { ...valid, categoriesDigest: null },
      { ...valid, categoriesDigest: 'Shopping' }, { ...valid, entries: null }, { ...valid, entries: { 0: entry } },
      { ...valid, entries: [null] }, { ...valid, entries: [[entry]] }, { ...valid, entries: [entry, entry] },
      { ...valid, note: 'synthetic extra field' },
      ...[{ productKey: [entry.productKey] }, { productKey: null }, { category: ['Shopping'] }, { category: null }, { category: 1 },
        { category: '<Shopping>' }, { confidence: '0.8' }, { confidence: [0.8] }, { confidence: null }, { confidence: true },
        { confidence: 1.5 }, { confidence: -0.1 }, { source: ['agent'] }, { source: null },
        { rationale: ['categorized from product title'] }, { note: 'synthetic extra field' }]
        .map(patch => ({ ...valid, entries: [{ ...entry, ...patch }] })),
    ];
    const runs = malformed.map((review, n) => pinned(review, `agent-coerced-${n}`));
    const before = files();
    for (const [n, args] of runs.entries()) {
      stderr = '';
      expect(await run([...args, '--backup', path.join(dir, `never-${n}.db`)]), JSON.stringify(malformed[n])).toBe(1);
      expect(stderr, JSON.stringify(malformed[n])).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(files()).toEqual(before);
    // Pinned to a database that doesn't exist, each is a refusal, not a failed open, and creates nothing.
    const absent = path.join(dir, 'absent.db');
    for (const review of malformed) {
      stderr = '';
      const goFile = json('go-agent-absent.json', { ...JSON.parse(fs.readFileSync(go('review', review), 'utf8')),
        databaseRef: digest(path.resolve(absent)) });
      expect(await run(['review', '--db', absent, '--input', json('agent-absent.json', review), '--root-go', goFile,
        '--backup', path.join(dir, 'never.db')]), JSON.stringify(review)).toBe(1);
      expect(stderr, JSON.stringify(review)).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(fs.readdirSync(dir).filter(name => name.startsWith('absent.db') || name.startsWith('never'))).toEqual([]);
    // The same classification, well formed, still applies.
    expect(await run([...pinned(valid, 'agent-valid'), '--backup', path.join(dir, 'agent-backup.db')])).toBe(0);
    const db = new Database(file, { readonly: true });
    try { expect(db.prepare('SELECT category FROM amazon_agent_categories').pluck().all()).toEqual(['Shopping']); }
    finally { db.close(); }
  });
  it('STEP 9 integration B7b (Root): review applies only an agent-category adoption; a taxonomy or mixed adoption refuses whole', async () => {
    const c = syntheticCapture();
    expect(await run(['import', '--db', file, '--input', json('capture.json', c), '--backup', path.join(dir, 'import.db'),
      '--root-go', go('import', c)])).toBe(0);
    const keys = [digest('synthetic new key'), digest('synthetic other key')].sort(), oldKey = digest('synthetic old key');
    const category = (productKey: string) => ({ productKey, previousProductKey: oldKey, category: 'Shopping', confidence: 0.9 });
    const taxonomy = (productKey: string) => ({ productKey, previousProductKey: oldKey, node: 'groceries/produce', confidence: 0.9,
      source: 'agent' });
    const adoption = (entries: unknown[]) => ({ kind: 'adoption', productsDigest: digest(entries), categoriesDigest: digest(['Shopping']),
      entries });
    const refused: unknown[] = [
      { format: 'holdr.amazon-item-taxonomy-mapping', version: 1, taxonomyVersion: 1, reviewed: true, kind: 'adoption',
        entries: [taxonomy(keys[0])] },
      adoption([taxonomy(keys[0])]),
      adoption([category(keys[0]), taxonomy(keys[1])]),
      adoption([{ ...category(keys[0]), node: 'groceries/produce' }]),
    ];
    const runs = refused.map((review, n) => {
      const goFile = path.join(dir, `go-adoption-${n}.json`);
      fs.renameSync(go('review', review), goFile);
      return ['review', '--db', file, '--input', json(`adoption-${n}.json`, review), '--root-go', goFile];
    });
    const backup = path.join(dir, 'never.db'), before = files();
    for (const [n, args] of runs.entries()) {
      stderr = '';
      expect(await run([...args, '--backup', backup]), String(n)).toBe(1);
      expect(stderr, String(n)).toBe('amazon: input-refused HoldrRefusal\n');
    }
    expect(files()).toEqual(before);
    // An agent-category adoption reaches #174's path: its application-time guard refuses this one as stale, writing nothing.
    const valid = adoption([category(keys[0])]), goFile = path.join(dir, 'go-adoption-valid.json');
    fs.renameSync(go('review', valid), goFile);
    stdout = '';
    expect(await run(['review', '--db', file, '--input', json('adoption-valid.json', valid), '--root-go', goFile,
      '--backup', path.join(dir, 'adoption-backup.db')])).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'adoption-stale' });
  });
  it('counts a learned product key in the import output, and adoption-review writes the private adoption only a GO\'d review applies', async () => {
    seedCards([{ amountMinor: 1100, description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping' }]);
    const shown = () => opened(db => {
      const order = getAmazonOrder(db, listAmazonOrders(db, 0, 1).orders[0].ref)!;
      return { digest: db.prepare('SELECT latest_digest FROM amazon_orders').pluck().get(),
        categories: order.items.map(i => [i.category, i.categorySource]) };
    });
    const unread = learnedRead(1, null), learned = learnedRead(2, 'SYNTH00001'), later = learnedRead(3, 'SYNTH00001');
    expect(compareObservation(learned.staging.orders[0], unread.staging.orders[0])).toBe('superset');
    await importRead(unread, 1);
    const oldKey = productKey(projectProducts([unread]).products[0]), newKey = productKey(projectProducts([learned]).products[0]);
    // The agent categorizes the displayed line's product through its own GO'd review.
    const first = makeAgentReview(projectProducts([unread]), ['Shopping'], [{ productKey: oldKey, category: 'Shopping',
      confidence: 0.8, source: 'agent', rationale: 'categorized from product title' }]);
    expect(await reviewFile(json('agent-1.json', first), 'agent-1')).toBe(0);
    const before = shown();
    expect(before.categories).toEqual([['Shopping', 'agent-classification']]);
    const receipt = await importRead(learned, 2);
    expect(receipt.holds).toContainEqual({ reason: 'agent-category-new-key', count: 1 });
    expect(receipt.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
    const secrets = [learned.staging.orders[0].items[0].title, 'SYNTH00001', oldKey, newKey];
    for (const value of secrets) expect(stdout + stderr).not.toContain(value);
    expect(shown()).toEqual(before);
    const adoptions = opened(categoryKeyAdoptions);
    expect(adoptions).toEqual([{ productKey: newKey, previousProductKey: oldKey, category: 'Shopping', confidence: 0.8 }]);

    // adoption-review is read-only (no GO, no backup): a new private adoption of exactly the listed keys, counts on stdout.
    const out = privateDir('private'), output = path.join(out, 'adoption-review.json');
    const adopt = (to: string) => run(['adoption-review', '--db', file, '--output', to]);
    const bytes = fs.readFileSync(file), files = fs.readdirSync(dir);
    stdout = ''; stderr = '';
    expect(await adopt(output)).toBe(0);
    const written = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(written).toEqual({ kind: 'adoption', productsDigest: digest(adoptions), categoriesDigest: digest(['Shopping']),
      entries: adoptions });
    expect(JSON.parse(stdout)).toEqual({ code: 'adoption-review-written-not-applied', adoptions: 1, ambiguous: 0, outsideInventory: 0,
      reviewDigest: digest(written) });
    expect(stderr).toBe('');
    expect(fs.readdirSync(out)).toEqual(['adoption-review.json']);
    for (const value of [...secrets, dir, fs.realpathSync(dir), out]) expect(stdout).not.toContain(value);
    // Opened read-only: the database's bytes are unchanged; at most SQLite's empty reader sidecars appear beside it.
    expect(fs.readFileSync(file)).toEqual(bytes);
    const sidecars = [`${path.basename(file)}-wal`, `${path.basename(file)}-shm`];
    expect(fs.readdirSync(dir).filter(name => !files.includes(name) && !sidecars.includes(name))).toEqual([]);
    expect(fs.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
    expect(opened(categoryKeyAdoptions)).toEqual(adoptions);
    // The output is exclusive: a re-run to the same file refuses, path-free, and leaves it unchanged.
    const saved = fs.readFileSync(output);
    stdout = ''; stderr = '';
    expect(await adopt(output)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
    expect(fs.readFileSync(output)).toEqual(saved);
    // An output inside the repository refuses and creates nothing.
    const inside = path.join(path.dirname(fileURLToPath(import.meta.url)), `synthetic-adoption-review-${process.pid}.json`);
    try {
      stderr = '';
      expect(await adopt(inside)).toBe(1);
      expect(stderr).toBe('amazon: input-refused HoldrRefusal\n');
      expect(fs.existsSync(inside)).toBe(false);
    } finally { fs.rmSync(inside, { force: true }); }

    // Only the existing review applies it, under its own Root GO pinned to the adoption: without one, or with a GO for
    // another input, it refuses before any backup.
    const backup = path.join(dir, 'adopt.db'), apply = ['review', '--db', file, '--input', output, '--backup', backup];
    stderr = '';
    expect(await run(apply)).toBe(1);
    expect(await run([...apply, '--root-go', go('review', { ...written, entries: [] })])).toBe(1);
    expect(stderr).toBe('amazon: input-refused HoldrRefusal\n'.repeat(2));
    expect(fs.existsSync(backup)).toBe(false);
    expect(opened(categoryKeyAdoptions)).toEqual(adoptions);
    // With its GO, the agent categories gain exactly the adopted row; nothing else changes but the review's audit.
    const unchanged = tables();
    stdout = '';
    expect(await run([...apply, '--root-go', go('review', written)])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'reconciled' });
    expect(fs.existsSync(backup)).toBe(true);
    const applied = tables();
    expect(Object.keys(applied).filter(name => JSON.stringify(applied[name]) !== JSON.stringify(unchanged[name])))
      .toEqual(['amazon_agent_categories', 'amazon_audit']);
    expect(applied.amazon_agent_categories).toEqual([...unchanged.amazon_agent_categories, { product_key: newKey,
      category: 'Shopping', confidence: 0.8, source: 'agent', rationale: 'categorized from product title' }]);
    expect((applied.amazon_audit.slice(unchanged.amazon_audit.length) as Array<{ action: string; after_digest: string }>)
      .map(a => [a.action, a.after_digest])).toEqual([['owner-review', digest(written)]]);
    expect(opened(categoryKeyAdoptions)).toEqual([]);
    // Nothing is left to adopt, so nothing is written.
    const again = path.join(out, 'adoption-review-again.json');
    stdout = '';
    expect(await adopt(again)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'adoption-review-nothing-to-adopt', adoptions: 0, ambiguous: 0, outsideInventory: 0 });
    expect(fs.existsSync(again)).toBe(false);
    // The order's next re-read replaces the display, with every category unchanged.
    const next = await importRead(later, 3), after = shown();
    expect(next.holds.map(h => h.reason)).not.toContain('agent-category-new-key');
    expect(after.digest).not.toBe(before.digest);
    expect(after.categories).toEqual(before.categories);
  });
  it('applies an adoption only while every entry is current: otherwise adoption-stale, whole and with no writes', async () => {
    seedCards([{ amountMinor: 1100, description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping' },
      { amountMinor: 777, description: 'SYNTHETIC HOUSEHOLD', issuerCategory: 'Synthetic household' }]);
    const unread = learnedRead(1, null), learned = learnedRead(2, 'SYNTH00001');
    const oldKey = productKey(projectProducts([unread]).products[0]), newKey = productKey(projectProducts([learned]).products[0]);
    // A generic agent-classification review, GO'd as always: it replaces a key's agent category (an upsert).
    let reviews = 0;
    const agentReview = async (key: string, category: string, confidence: number) => {
      const review = makeAgentReview(projectProducts([unread, learned]), ['Shopping', 'Synthetic household'], [{ productKey: key,
        category, confidence, source: 'agent', rationale: 'categorized from product title' }]);
      expect(await reviewFile(json(`agent-${++reviews}.json`, review), `agent-${reviews}`)).toBe(0);
    };
    const agentRow = (key: string) => opened(db => db.prepare(`SELECT category,confidence FROM amazon_agent_categories
      WHERE product_key=?`).get(key));
    await importRead(unread, 1);
    await agentReview(oldKey, 'Shopping', 0.8);
    await importRead(learned, 2);
    const out = privateDir('private');
    const written = async (n: number) => {
      const output = path.join(out, `adoption-${n}.json`);
      stdout = '';
      expect(await run(['adoption-review', '--db', file, '--output', output])).toBe(0);
      return { output, adoption: JSON.parse(fs.readFileSync(output, 'utf8')) as { entries: unknown[] } };
    };
    // Applied after its entries changed, it writes nothing (the pre-write backup remains) and prints counts only.
    const refused = async (output: string, n: number) => {
      const unchanged = tables();
      expect(await reviewFile(output, `adoption-${n}`)).toBe(1);
      expect(JSON.parse(stdout)).toEqual({ code: 'adoption-stale', entries: 1, stale: 1 });
      expect(stderr).toBe('');
      expect(tables()).toEqual(unchanged);
      expect(fs.existsSync(path.join(dir, `review-adoption-${n}.db`))).toBe(true);
    };
    // The old key's confidence changes after the adoption is written.
    const first = await written(1), entry = { productKey: newKey, previousProductKey: oldKey, category: 'Shopping', confidence: 0.8 };
    expect(first.adoption).toEqual({ kind: 'adoption', productsDigest: digest([entry]),
      categoriesDigest: digest(['Shopping', 'Synthetic household']), entries: [entry] });
    await agentReview(oldKey, 'Shopping', 0.35);
    expect(agentRow(oldKey)).toEqual({ category: 'Shopping', confidence: 0.35 });
    await refused(first.output, 1);
    // Written again, then the old key's category changes: a generic review still replaces a different category.
    const second = await written(2);
    expect(second.adoption.entries).toEqual([{ ...entry, confidence: 0.35 }]);
    await agentReview(oldKey, 'Synthetic household', 0.6);
    expect(agentRow(oldKey)).toEqual({ category: 'Synthetic household', confidence: 0.6 });
    await refused(second.output, 2);
    // Written again, then the agent categorizes the new key itself: the adoption never overwrites it.
    const third = await written(3);
    expect(third.adoption.entries).toEqual([{ productKey: newKey, previousProductKey: oldKey, category: 'Synthetic household',
      confidence: 0.6 }]);
    await agentReview(newKey, 'Shopping', 0.5);
    await refused(third.output, 3);
    expect(agentRow(newKey)).toEqual({ category: 'Shopping', confidence: 0.5 });
    // Nothing is offered over the agent's own decision: the line stays unmatched, for the owner.
    stdout = '';
    expect(await run(['adoption-review', '--db', file, '--output', path.join(out, 'adoption-4.json')])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'adoption-review-nothing-to-adopt', adoptions: 0, ambiguous: 0, outsideInventory: 0 });
    expect((await importRead(learnedRead(3, 'SYNTH00001'), 3)).holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
  });
  it('adoption-review takes exactly --db and --output, never creates or migrates a database, and never writes over one', async () => {
    const out = privateDir('private'), output = path.join(out, 'adoption-review.json');
    const refused = async (args: string[], error = /^amazon: input-refused HoldrRefusal\n$/) => {
      stdout = ''; stderr = '';
      expect(await run(['adoption-review', ...args])).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(error);
    };
    await refused(['--db', file]);
    await refused(['--output', output]);
    await refused(['--db', 'finance.db', '--output', output]);
    await refused(['--db', file, '--output', 'adoption-review.json']);
    await refused(['--db', file, '--output', output, '--backup', path.join(dir, 'backup.db')]);
    await refused(['--db', file, '--output', output, '--root-go', go('review', null)]);
    expect(fs.existsSync(path.join(dir, 'backup.db'))).toBe(false);
    // A missing database is never created, and nothing appears at its path.
    await refused(['--db', path.join(dir, 'missing.db'), '--output', output], /^amazon: operation-failed SqliteError SQLITE_CANTOPEN\n$/);
    expect(fs.readdirSync(dir).filter(name => name.startsWith('missing.db'))).toEqual([]);
    // Never the database itself or one of its reserved sidecars, even in a private directory.
    const privateDb = path.join(out, 'finance.db');
    fs.copyFileSync(file, privateDb);
    for (const target of [privateDb, `${privateDb}-wal`, `${privateDb}-shm`, `${privateDb}-journal`]) {
      await refused(['--db', privateDb, '--output', target]);
    }
    expect(fs.readdirSync(out)).toEqual(['finance.db']);
    expect(fs.readFileSync(privateDb)).toEqual(fs.readFileSync(file));
    // A database without the Amazon schema has nothing to adopt and stays without it.
    const bytes = fs.readFileSync(file);
    stdout = ''; stderr = '';
    expect(await run(['adoption-review', '--db', file, '--output', output])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'adoption-review-nothing-to-adopt', adoptions: 0, ambiguous: 0, outsideInventory: 0 });
    expect(stderr).toBe('');
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(bytes);
    const db = new Database(file, { readonly: true });
    try { expect(hasAmazonSchema(db)).toBe(false); } finally { db.close(); }
  });
});
