import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ITEM_TAXONOMY_ASSET_NODE as ASSET, ITEM_TAXONOMY_V2_DIGEST } from '@finance-tracker/shared';

import { ADMINISTRATORS_SID, SYSTEM_SID, type WindowsAcl } from '../e2e/windowsAcl.js';
import { digest } from '../services/amazon/policy.js';
import {
  RETAIL_POLICY_DIGEST,
  RETAIL_SCHEMA_DIGEST,
  RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT,
  RETAIL_TAXONOMY_MAPPING_FORMAT,
  RETAIL_TAXONOMY_WORKLIST_FORMAT,
  retailDepartmentKey,
  retailProductKey,
  retailTaxonomyMappingOf,
  retailTaxonomyWorklistOf,
  serializeRetailTaxonomyMapping,
  type RetailTaxonomyEntry,
} from '../services/retail/index.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { NO_RESERVED, RETAIL_RESERVED_FIXTURES, importPayload, reservedValuesStored, retailReservedBase } from '../testing/retailDb.js';
import {
  SYNTHETIC_RETAIL_VALUES,
  goldBar,
  onlineLine,
  onlineOrder,
  retailPayloadText,
  syntheticRetailPayload,
  valueFreeText,
  warehouseKey,
  warehouseLine,
  warehouseReceipt,
} from '../testing/retailPayloads.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import type { OutputAccess } from './ownerOnlyOutput.js';
import { RETAIL_CLI_USAGE, runRetailCli, type RetailProbePoint } from './retail.js';

// `holdr-retail taxonomy …` (Costco 3/7 plan v5 §6–§8, §10): synthetic only. A database this build makes in a scratch
// directory, invented receipts (item numbers 100100 and up, departments 731 and 853), mappings and GO ids.

let template: string, root: string, dir: string, file: string, stdout: string, stderr: string, transcript: string;
let cases = 0;
const NOW = new Date('2031-03-01T12:00:00.000Z');
const BASE_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD', 'HOLDR_CONFIG'].includes(name)));
const DISPOSABLE = { ...BASE_ENV, HOLDR_CONFIG: 'none' };
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
const SHARED = standIn([{ sid: USERS_SID, rights: 0x120089, type: 'Allow' }]);
const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs');

const run = (args: string[], options: { access?: OutputAccess; probe?: (point: RetailProbePoint) => void } = {}) => runRetailCli(args, {
  env: DISPOSABLE, now: () => NOW, outputAccess: options.access ?? OWNER_ONLY, probe: options.probe,
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
const fresh = () => {
  dir = path.join(root, `case-${++cases}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
  stdout = '';
};
const sha256 = (target: string) => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const output = () => {
  const value = JSON.parse(stdout) as Record<string, any>;
  stdout = '';
  return value;
};
const go = (command: string, patch: Record<string, unknown> = {}) => write(`go-${randomBytes(6).toString('hex')}.json`, {
  format: 'holdr.retail-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command, goId: randomBytes(16).toString('hex'),
  databaseRef: digest(path.resolve(file)), schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST, ...patch,
});
const newBackup = () => at(`backup-${randomBytes(4).toString('hex')}.db`);
const backups = () => fs.readdirSync(dir).filter((name) => /^backup-[0-9a-f]{8}\.db$/.test(name)).sort();
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
const membershipRef = () => opened((db) => db.prepare('SELECT membership_ref FROM retail_memberships WHERE folder = ?').pluck().get('costco'));
const install = () => run(['install', '--db', file, '--go', go('install'), '--backup', newBackup()]);
async function importFile(payload: string, declaration: string | null = null) {
  const membership = declaration !== null ? { declarationSha256: sha256(declaration) } : { membershipRef: membershipRef() };
  return run(['import', '--db', file, '--payload', payload, ...(declaration !== null ? ['--declaration', declaration] : []), '--go',
    go('import', { inputSha256: sha256(payload), membership }), '--backup', newBackup()]);
}

const product = (itemNumber: string) => retailProductKey('costco', itemNumber);
const department = (number: number) => retailDepartmentKey('costco', number);
const SENTINELS = /100100|100101|100102|SAMPLE|Sample|731|853/;
/** Receipt 1 (products 100100 and 100101 in departments 731 and 853, a gold bar, a line without an item number) and order 2. */
const receipts = () => [
  warehouseReceipt(1, { lines: [
    warehouseLine(0, 1_000, { itemNumber: '100100', department: 731 }),
    warehouseLine(1, 1_000, { itemNumber: '100101', department: 853 }),
    warehouseLine(2, 2_000, { itemNumber: '100102', department: 731, title: 'SAMPLE BULLION BAR', metal: goldBar() }),
    warehouseLine(3, 500, { itemNumber: null, department: 853 }),
  ] }),
  onlineOrder(2, { lines: [onlineLine(2, 0, 5_000, { itemNumber: '100100' })] }),
];
/** Installs and imports the receipts, then receipt 1 read again with another date: quarantined, sighted by two imports. */
async function seed(): Promise<void> {
  expect(await install()).toBe(0);
  const declaration = write('declaration.json', JSON.stringify({ format: 'holdr.retail-membership-declaration', version: 1, merchant: 'costco',
    folder: 'costco', owner: 'alex', label: 'Sample Household' }));
  expect(await importFile(write('first.json', retailPayloadText(syntheticRetailPayload({ capture: 'c', receipts: receipts() }))), declaration)).toBe(0);
  expect(await importFile(write('second.json', retailPayloadText(syntheticRetailPayload({ capture: 'd', receipts: [{ ...receipts()[0], date: '2031-01-12' }] })))))
    .toBe(0);
  stdout = '';
}
/** Another membership's receipt, of other products: a retail write unrelated to any mapping here. */
const unrelatedImport = (db: Database.Database) => importPayload(db, syntheticRetailPayload({ folder: 'costco-2', capture: 'e',
  receipts: [warehouseReceipt(7, { lines: [warehouseLine(0, 900, { itemNumber: '100109', department: 12 })] })] }));

let decisions = 0;
const owner = (itemNumber: string, node: string | null): RetailTaxonomyEntry =>
  ({ subjectKind: 'product', subjectKey: product(itemNumber), source: 'owner', node: node as RetailTaxonomyEntry['node'], confidenceBp: null });
const agent = (itemNumber: string, node: string | null, confidenceBp: number | null): RetailTaxonomyEntry =>
  ({ subjectKind: 'product', subjectKey: product(itemNumber), source: 'agent', node: node as RetailTaxonomyEntry['node'], confidenceBp });
const reviewed = (number: number, node: string | null): RetailTaxonomyEntry =>
  ({ subjectKind: 'department', subjectKey: department(number), source: 'department-review', node: node as RetailTaxonomyEntry['node'], confidenceBp: null });
/** A new mapping file of these entries, sorted as the format requires, under a fresh decision. */
function mappingFile(entries: RetailTaxonomyEntry[]): string {
  const sorted = [...entries].sort((a, b) => (`${a.subjectKind} ${a.subjectKey} ${a.source}` < `${b.subjectKind} ${b.subjectKey} ${b.source}` ? -1 : 1));
  const mapping = retailTaxonomyMappingOf({ format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 2, reviewed: true,
    decisionId: (++decisions).toString(16).padStart(32, 'c'), entries: sorted });
  return write(`mapping-${randomBytes(4).toString('hex')}.json`, serializeRetailTaxonomyMapping(mapping));
}
/** `taxonomy plan`'s answer for a mapping, as an operator reads it to ask for a GO. */
async function planOf(mapping: string): Promise<Record<string, any>> {
  stdout = '';
  expect(await run(['taxonomy', 'plan', '--db', file, '--mapping', mapping])).toBe(0);
  return output();
}
/** A GO for this mapping, from its plan as printed now. */
async function taxonomyGo(mapping: string, patch: Record<string, unknown> = {}): Promise<string> {
  const plan = await planOf(mapping);
  return go('taxonomy-import', { mappingSha256: plan.mappingSha256, decisionId: plan.decisionId, taxonomyDigest: plan.taxonomyDigest,
    planDigest: plan.planDigest, ...patch });
}
const importArgs = (mapping: string, goFile: string) => ['taxonomy', 'import', '--db', file, '--mapping', mapping, '--go', goFile, '--backup', newBackup()];
/** Plans, asks for a GO and imports a mapping; returns the exit code (the output stays in stdout). */
async function importMapping(entries: RetailTaxonomyEntry[]): Promise<number> {
  const mapping = mappingFile(entries);
  return run(importArgs(mapping, await taxonomyGo(mapping)));
}
const taxonomyImports = (target = file) => count('SELECT count(*) FROM retail_taxonomy_imports', target);
const currentOwner = (itemNumber: string) => opened((db) => db.prepare(`SELECT a.node FROM retail_taxonomy_assignments a
  JOIN retail_taxonomy_imports t ON t.taxonomy_import_id = a.taxonomy_import_id
  WHERE a.subject_key = ? AND a.source = 'owner' ORDER BY t.seq DESC LIMIT 1`).pluck().get(product(itemNumber)));

beforeAll(async () => {
  template = await makeScratchDir('retail-taxonomy-cli-template-');
  const repo = new SqliteStateRepo({ file: path.join(template, 'finance.db') });
  repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '0007', currency: 'USD' });
  repo.close();
  const db = new Database(path.join(template, 'finance.db'));
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = ''; transcript = '';
  root = dir = await makeScratchDir('retail-taxonomy-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(root); });

describe('holdr-retail taxonomy worklist (§6.1, §7.1, §7.2)', () => {
  it('writes a new owner-only worklist and prints counts and its SHA-256 only, never a title, item number or department', async () => {
    await seed();
    const before = fs.readFileSync(file);
    for (const [access, code] of [[SHARED, 'retail-output-not-owner-only'], [{ ...OWNER_ONLY, readAcls: () => { throw new Error('unreadable'); } },
      'retail-output-uncheckable']] as const) {
      expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')], { access })).toBe(1);
      expect(output()).toEqual({ code });
    }
    expect(fs.existsSync(at('worklist.json'))).toBe(false);
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')])).toBe(0);
    expect(output()).toEqual({ code: 'retail-taxonomy-worklist-written', schema: 'present', products: 3, departments: 2,
      coverage: { withProduct: 4, withoutProduct: 1, titleRule: 1 }, worklistSha256: sha256(at('worklist.json')) });
    const listed = retailTaxonomyWorklistOf(JSON.parse(fs.readFileSync(at('worklist.json'), 'utf8')));
    expect(listed.format).toBe(RETAIL_TAXONOMY_WORKLIST_FORMAT);
    expect(listed.products.map((entry) => [entry.itemNumber, entry.lines, entry.byDepartment.map((group) => group.department)]).sort()).toEqual([
      ['100100', 2, [731, null]], ['100101', 1, [853]], ['100102', 1, [731]]]);
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')])).toBe(1);
    expect(output()).toEqual({ code: 'retail-output-exists' });
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', 'worklist.json'])).toBe(1);
    expect(output()).toEqual({ code: 'retail-path-not-absolute' });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(valueFreeText(transcript)).not.toMatch(SENTINELS);
  });

  it('writes an empty worklist, and says so, when the retail tables are absent', async () => {
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')])).toBe(0);
    expect(output()).toEqual({ code: 'retail-taxonomy-worklist-written', schema: 'absent', products: 0, departments: 0,
      coverage: { withProduct: 0, withoutProduct: 0, titleRule: 0 }, worklistSha256: sha256(at('worklist.json')) });
  });
});

describe('holdr-retail taxonomy adopt (§6.2, §7.1)', () => {
  it('adopts a classifier\'s output as agent rows only, bound to its worklist, under a fresh decisionId each time', async () => {
    await seed();
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')])).toBe(0);
    stdout = '';
    const listed = retailTaxonomyWorklistOf(JSON.parse(fs.readFileSync(at('worklist.json'), 'utf8')));
    const classifier = (products: unknown[], worklistSha256 = sha256(at('worklist.json'))) => write(`assignments-${randomBytes(4).toString('hex')}.json`, {
      format: RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT, version: 1, taxonomyVersion: 2, generatedAt: '2031-03-01T12:00:00.000Z', inputs: { worklistSha256 },
      products });
    const output1 = classifier(listed.products.map((entry, index) => ({ subjectKey: entry.subjectKey, node: index === 0 ? ASSET : 'household',
      confidenceBp: 7_000 + index })));
    const adopted: Array<Record<string, any>> = [];
    for (const out of [at('mapping-1.json'), at('mapping-2.json')]) {
      expect(await run(['taxonomy', 'adopt', '--input', output1, '--worklist', at('worklist.json'), '--out', out])).toBe(0);
      adopted.push(output());
      expect(adopted.at(-1)).toEqual({ code: 'retail-taxonomy-mapping-written', entries: 3, decisionId: expect.stringMatching(/^[0-9a-f]{32}$/),
        mappingSha256: sha256(out) });
    }
    expect(adopted[0].decisionId).not.toBe(adopted[1].decisionId);
    expect(adopted[0].mappingSha256).not.toBe(adopted[1].mappingSha256);
    const mapping = retailTaxonomyMappingOf(JSON.parse(fs.readFileSync(at('mapping-1.json'), 'utf8')));
    expect(mapping.entries.map((entry) => [entry.subjectKind, entry.source])).toEqual([['product', 'agent'], ['product', 'agent'], ['product', 'agent']]);
    // Bound to its worklist and its products; a new file only.
    expect(await run(['taxonomy', 'adopt', '--input', classifier(listed.products.map((entry) => ({ subjectKey: entry.subjectKey, node: 'household',
      confidenceBp: 9_000 })), 'f'.repeat(64)), '--worklist', at('worklist.json'), '--out', at('mapping-3.json')])).toBe(1);
    expect(output()).toEqual({ code: 'retail-taxonomy-worklist-mismatch' });
    expect(await run(['taxonomy', 'adopt', '--input', classifier([{ subjectKey: 'p'.repeat(64), node: 'household', confidenceBp: 9_000 }]),
      '--worklist', at('worklist.json'), '--out', at('mapping-3.json')])).toBe(1);
    expect(output()).toEqual({ code: 'retail-taxonomy-subject-unknown', subjects: 1 });
    expect(await run(['taxonomy', 'adopt', '--input', output1, '--worklist', at('worklist.json'), '--out', at('mapping-1.json')])).toBe(1);
    expect(output()).toEqual({ code: 'retail-output-exists' });
    expect(fs.existsSync(at('mapping-3.json'))).toBe(false);
  });
});

describe('holdr-retail taxonomy plan (§7.1, §7.3)', () => {
  it('plans read-only: actions, counters, the categories the card data lacks, and the digests a GO pins', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries'), agent('100101', 'household', 6_500), reviewed(853, 'home-kitchen')]);
    const before = fs.readFileSync(file);
    const plan = await planOf(mapping);
    expect(plan).toEqual({
      code: 'retail-taxonomy-planned', schema: 'present', entries: 3, actions: { insert: 3, replace: 0, withdraw: 0, unchanged: 0 },
      products: { total: 3, assigned: 1, suggested: 1, needsReview: 1, withSuggestion: 0, assetFiled: 0 },
      productSources: { ownerRows: 1, agentRows: 1, noRow: 1, explicitResidual: 0 },
      lines: { total: 5, assigned: 4, suggested: 1, needsReview: 0, withSuggestion: 0, assetFiled: 1, metalHold: 1 },
      lineSources: { titleRule: 1, owner: 2, agent: 1, department: 1, none: 0, withoutProduct: 1 },
      rowsNotCurrent: 0, categoriesMissing: { count: expect.any(Number), nodes: expect.arrayContaining(['groceries', 'automotive/fuel']) },
      mappingSha256: sha256(mapping), decisionId: expect.stringMatching(/^[0-9a-f]{32}$/), taxonomyDigest: ITEM_TAXONOMY_V2_DIGEST,
      schemaDigest: RETAIL_SCHEMA_DIGEST, policyDigest: RETAIL_POLICY_DIGEST, databaseRef: digest(path.resolve(file)), planDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(plan.categoriesMissing.nodes).not.toContain(ASSET);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(await run(['taxonomy', 'plan', '--db', file, '--mapping', mappingFile([owner('100199', 'groceries')])])).toBe(1);
    expect(output()).toEqual({ code: 'retail-taxonomy-subject-unknown', subjects: 1 });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('answers schema absent without the tables, and from the snapshot its STOP read, whatever another connection commits', async () => {
    const early = mappingFile([owner('100100', 'groceries')]);
    expect(await run(['taxonomy', 'plan', '--db', file, '--mapping', early])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-taxonomy-planned', schema: 'absent', mappingSha256: sha256(early) });
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const baseline = await planOf(mapping);
    let landed = 0;
    expect(await run(['taxonomy', 'plan', '--db', file, '--mapping', mapping], { probe: (point) => {
      if (point !== 'read-checked') return;
      landed += 1;
      writable(unrelatedImport);
    } })).toBe(0);
    expect(landed).toBe(1);
    expect(output()).toEqual(baseline);
    expect((await planOf(mapping)).planDigest).not.toBe(baseline.planDigest);
  });
});

describe('holdr-retail taxonomy import: the GO, replay and freshness (§6.4, §7.4)', () => {
  it('refuses a GO that is not exactly a Root GO for this mapping, decision, tree and plan, before any backup', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const plan = await planOf(mapping);
    const pins = { mappingSha256: plan.mappingSha256, decisionId: plan.decisionId, taxonomyDigest: plan.taxonomyDigest, planDigest: plan.planDigest };
    const taken = backups();
    const refused: Array<[string, string, Record<string, unknown>, string]> = [
      ['another command', 'import', pins, 'retail-go-invalid'],
      ['another command\'s purpose', 'taxonomy-import', { ...pins, purpose: 'production-import' }, 'retail-purpose-invalid'],
      ['plan v5\'s draft purpose name', 'taxonomy-import', { ...pins, purpose: 'production-taxonomy-import' }, 'retail-purpose-invalid'],
      ['another tree', 'taxonomy-import', { ...pins, taxonomyDigest: 'f'.repeat(64) }, 'retail-go-invalid'],
      ['no plan digest', 'taxonomy-import', { ...pins, planDigest: 'later' }, 'retail-go-invalid'],
      ['another schema', 'taxonomy-import', { ...pins, schemaDigest: 'f'.repeat(64) }, 'retail-go-invalid'],
      ['another database', 'taxonomy-import', { ...pins, databaseRef: 'f'.repeat(64) }, 'retail-go-invalid'],
      ['a GO id of another shape', 'taxonomy-import', { ...pins, goId: 'G'.repeat(32) }, 'retail-go-id-invalid'],
      ['another mapping', 'taxonomy-import', { ...pins, mappingSha256: 'f'.repeat(64) }, 'retail-input-mismatch'],
      ['another decision', 'taxonomy-import', { ...pins, decisionId: 'f'.repeat(32) }, 'retail-input-mismatch'],
      ['a key more', 'taxonomy-import', { ...pins, note: 'x' }, 'retail-go-invalid'],
    ];
    for (const [what, command, patch, code] of refused) {
      expect(await run(importArgs(mapping, go(command, patch))), what).toBe(1);
      expect(output(), what).toEqual({ code });
    }
    expect(backups()).toEqual(taken);
    expect(taxonomyImports()).toBe(0);
  });

  it('imports after a backup; the same mapping again is already-imported before any freshness check, with no backup', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const goFile = await taxonomyGo(mapping);
    const taken = backups().length;
    expect(await run(importArgs(mapping, goFile))).toBe(0);
    const imported = output();
    expect(imported).toEqual({ code: 'retail-taxonomy-imported', purpose: 'copy-rehearsal', goId: expect.stringMatching(/^[0-9a-f]{32}$/),
      mappingSha256: sha256(mapping), taxonomyImportId: expect.stringMatching(/^rtl-tax-[a-p]{32}$/), seq: 1, entries: 1,
      actions: { insert: 1, replace: 0, withdraw: 0, unchanged: 0 }, planDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(backups()).toHaveLength(taken + 1);
    writable(unrelatedImport);
    const replayed = await run(importArgs(mapping, goFile));
    expect([replayed, output()]).toEqual([0, { code: 'retail-already-imported', goId: imported.goId, mappingSha256: sha256(mapping),
      taxonomyImportId: imported.taxonomyImportId, seq: 1 }]);
    expect(backups()).toHaveLength(taken + 1);
    expect(taxonomyImports()).toBe(1);
  });

  it('reasserts a decision: owner A, then B, then A again under a fresh decisionId imports a third time, and A is current (D-T1-1)', async () => {
    await seed();
    expect(await importMapping([owner('100100', 'groceries')])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-taxonomy-imported', seq: 1 });
    expect(await importMapping([owner('100100', 'household')])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-taxonomy-imported', seq: 2 });
    expect(await importMapping([owner('100100', 'groceries')])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-taxonomy-imported', seq: 3, actions: { insert: 0, replace: 1, withdraw: 0, unchanged: 0 } });
    expect(currentOwner('100100')).toBe('groceries');
    expect(await importMapping([owner('100100', 'groceries')])).toBe(0);
    expect(output()).toMatchObject({ code: 'retail-taxonomy-imported', seq: 4, actions: { insert: 0, replace: 0, withdraw: 0, unchanged: 1 } });
    expect(taxonomyImports()).toBe(4);
  });

  it('refuses a stale plan before any backup, writing nothing', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const goFile = await taxonomyGo(mapping);
    expect(await importMapping([agent('100101', 'household', 9_000)])).toBe(0);
    stdout = '';
    const taken = backups();
    expect(await run(importArgs(mapping, goFile))).toBe(1);
    expect(output()).toEqual({ code: 'retail-plan-changed' });
    expect(backups(), 'no backup for a stale plan').toEqual(taken);
    expect(taxonomyImports()).toBe(1);
  });

  it('refuses each plan-to-import race, retail-plan-changed with nothing written: the audit fence (D-T1-2, D-T2-2)', async () => {
    const races: Array<[string, RetailTaxonomyEntry[], RetailTaxonomyEntry[] | null, RetailTaxonomyEntry[] | 'unrelated']> = [
      ['an owner withdrawal on the product of an agent import', [agent('100100', 'household', 9_000)], [owner('100100', 'groceries')],
        [owner('100100', null)]],
      ['a department mapping a product entry\'s lines fall back to', [agent('100100', 'household', 9_000)], null, [reviewed(731, 'dining')]],
      ['an owner row on a product under a department entry', [reviewed(853, 'home-kitchen')], null, [owner('100101', 'garden-patio')]],
      ['an unrelated retail import', [owner('100100', 'groceries')], null, 'unrelated'],
    ];
    for (const [what, entries, first, race] of races) {
      fresh();
      await seed();
      if (first !== null) expect(await importMapping(first), what).toBe(0);
      const mapping = mappingFile(entries);
      const goFile = await taxonomyGo(mapping);
      if (race === 'unrelated') writable(unrelatedImport);
      else expect(await importMapping(race), what).toBe(0);
      stdout = '';
      const taken = backups();
      const imports = taxonomyImports();
      const exit = await run(importArgs(mapping, goFile));
      expect([exit, output()], what).toEqual([1, { code: 'retail-plan-changed' }]);
      expect(backups(), what).toEqual(taken);
      expect(taxonomyImports(), what).toBe(imports);
    }
  });

  it('plans again under the fence: a race landed between the preflight and the fence is refused there, nothing written', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const goFile = await taxonomyGo(mapping);
    const taken = backups().length;
    const audit = count('SELECT max(seq) FROM retail_audit');
    const seen: RetailProbePoint[] = [];
    const exit = await run(importArgs(mapping, goFile), { probe: (point) => {
      seen.push(point);
      if (point === 'preflighted') writable(unrelatedImport);
    } });
    expect([exit, output()], 'refused under the fence').toEqual([1, { code: 'retail-plan-changed' }]);
    expect(seen).toEqual(['preflighted', 'fenced', 'backed-up']);
    expect(taxonomyImports()).toBe(0);
    expect(count('SELECT max(seq) FROM retail_audit')).toBe(audit + 1);
    expect(backups()).toHaveLength(taken + 1);
  });

  it('appends: two imports keep every row, select the latest per source, a withdrawal included, with one audit row each', async () => {
    await seed();
    expect(await importMapping([owner('100100', 'groceries'), agent('100100', 'household', 9_000)])).toBe(0);
    expect(await importMapping([owner('100100', null)])).toBe(0);
    stdout = '';
    expect(count('SELECT count(*) FROM retail_taxonomy_assignments')).toBe(3);
    expect(currentOwner('100100')).toBeNull();
    expect(opened((db) => db.prepare(`SELECT kind, input_sha256 AS input FROM retail_audit WHERE kind = 'taxonomy-import' ORDER BY seq`).all()))
      .toEqual(opened((db) => db.prepare('SELECT \'taxonomy-import\' AS kind, mapping_sha256 AS input FROM retail_taxonomy_imports ORDER BY seq').all()));
    const worklist = at('worklist.json');
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', worklist])).toBe(0);
    expect(retailTaxonomyWorklistOf(JSON.parse(fs.readFileSync(worklist, 'utf8'))).products.find((entry) => entry.itemNumber === '100100')?.current)
      .toEqual({ node: 'household', source: 'agent', confidenceBp: 9_000, suggested: false, suggestion: null });
  });
});

describe('holdr-retail taxonomy import: one fence from before the backup to the commit (§7.4, §8; D-T3-1, D-T4-1)', () => {
  it('backs up through a second, read-only connection under the fence: exactly the state before the import (D-T4-1)', async () => {
    await seed();
    expect(await importMapping([reviewed(731, 'dining')])).toBe(0);
    const mapping = mappingFile([owner('100100', 'groceries'), reviewed(853, 'home-kitchen')]);
    const goFile = await taxonomyGo(mapping);
    const objects = (target?: string) => opened((db) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(), target);
    const before = { objects: objects(), audit: count('SELECT max(seq) FROM retail_audit'), imports: taxonomyImports(),
      assignments: count('SELECT count(*) FROM retail_taxonomy_assignments') };
    const taken = backups();
    expect(await run(importArgs(mapping, goFile))).toBe(0);
    const imported = output();
    const added = backups().filter((name) => !taken.includes(name));
    expect(added).toHaveLength(1);
    const backup = at(added[0]);
    if (process.platform !== 'win32') expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(objects(backup)).toEqual(before.objects);
    expect(opened((db) => db.pragma('integrity_check', { simple: true }), backup)).toBe('ok');
    expect(count('SELECT max(seq) FROM retail_audit', backup)).toBe(before.audit);
    expect(taxonomyImports(backup)).toBe(before.imports);
    expect(count('SELECT count(*) FROM retail_taxonomy_assignments', backup)).toBe(before.assignments);
    expect(opened((db) => db.prepare('SELECT count(*) FROM retail_taxonomy_imports WHERE taxonomy_import_id = ?').pluck().get(imported.taxonomyImportId), backup))
      .toBe(0);
    expect([taxonomyImports(), count('SELECT max(seq) FROM retail_audit')]).toEqual([before.imports + 1, before.audit + 1]);
  });

  it('holds the write lock from before the backup until its commit: a second connection is refused SQLITE_BUSY at each point (D-T3-1)', async () => {
    await seed();
    writable((db) => db.exec('CREATE TABLE fence_probe (id INTEGER PRIMARY KEY)'));
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const goFile = await taxonomyGo(mapping);
    const audit = count('SELECT max(seq) FROM retail_audit');
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
      const seen: Array<[RetailProbePoint, string]> = [];
      expect(await run(importArgs(mapping, goFile), { probe: (point) => {
        if (point === 'fenced' || point === 'backed-up' || point === 'written') seen.push([point, attempt()]);
      } })).toBe(0);
      expect(output()).toMatchObject({ code: 'retail-taxonomy-imported', seq: 1 });
      expect(seen).toEqual([['fenced', 'busy'], ['backed-up', 'busy'], ['written', 'busy']]);
      expect(count('SELECT count(*) FROM fence_probe')).toBe(0);
      expect([taxonomyImports(), count('SELECT count(*) FROM retail_taxonomy_assignments'), count('SELECT max(seq) FROM retail_audit')])
        .toEqual([1, 1, audit + 1]);
      // The control: the same write, through the same hook, with no import running, lands.
      expect(attempt()).toBe('committed');
      expect(count('SELECT count(*) FROM fence_probe')).toBe(1);
    } finally {
      other.close();
    }
  });

  it('rolls back a failure under the fence after its writes: nothing written, the backup kept, the fence released', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const goFile = await taxonomyGo(mapping);
    const audit = count('SELECT max(seq) FROM retail_audit');
    const taken = backups().length;
    const failure = new Error('injected under the fence');
    expect(await run(importArgs(mapping, goFile), { probe: (point) => { if (point === 'written') throw failure; } })).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^holdr-retail: operation-failed /);
    expect([taxonomyImports(), count('SELECT count(*) FROM retail_taxonomy_assignments'), count('SELECT max(seq) FROM retail_audit')]).toEqual([0, 0, audit]);
    expect(backups()).toHaveLength(taken + 1);
    writable((db) => db.exec('CREATE TABLE fence_released (id INTEGER PRIMARY KEY)'));
    expect(count(`SELECT count(*) FROM sqlite_master WHERE name = 'fence_released'`)).toBe(1);
  });
});

describe('holdr-retail taxonomy: a stored reserved value stops every check point (§8)', () => {
  const reserved = Object.entries(RETAIL_RESERVED_FIXTURES);

  it('stops worklist, for each reserved row: no file written', async () => {
    for (const [what, add] of reserved) {
      fresh();
      await seed();
      const counts = writable((db) => add(db, retailReservedBase(db, warehouseKey(1))));
      expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')]), what).toBe(1);
      expect(output(), what).toEqual({ code: 'retail-reserved-value', ...counts });
      expect(fs.existsSync(at('worklist.json')), what).toBe(false);
    }
  });

  it('stops plan, for each reserved row', async () => {
    for (const [what, add] of reserved) {
      fresh();
      await seed();
      const mapping = mappingFile([owner('100100', 'groceries')]);
      const counts = writable((db) => add(db, retailReservedBase(db, warehouseKey(1))));
      expect(await run(['taxonomy', 'plan', '--db', file, '--mapping', mapping]), what).toBe(1);
      expect(output(), what).toEqual({ code: 'retail-reserved-value', ...counts });
    }
  });

  it('stops import before the backup, for each reserved row, and a replay over one: never already-imported', async () => {
    for (const [what, add] of reserved) {
      fresh();
      await seed();
      const replayed = mappingFile([owner('100101', 'garden-patio')]);
      const replayGo = await taxonomyGo(replayed);
      expect(await run(importArgs(replayed, replayGo)), what).toBe(0);
      const mapping = mappingFile([owner('100100', 'groceries')]);
      const goFile = await taxonomyGo(mapping);
      const counts = writable((db) => add(db, retailReservedBase(db, warehouseKey(1))));
      const taken = backups();
      expect(await run(importArgs(mapping, goFile)), what).toBe(1);
      expect(output(), what).toEqual({ code: 'retail-reserved-value', ...counts });
      expect(backups(), `${what}: no backup before the fence`).toEqual(taken);
      expect(await run(importArgs(replayed, replayGo)), what).toBe(1);
      expect(output(), `${what}: the replay`).toEqual({ code: 'retail-reserved-value', ...counts });
      expect(backups(), `${what}: no backup for the replay`).toEqual(taken);
      expect(taxonomyImports(), what).toBe(1);
    }
  });

  it('stops import under the fence on a reserved row written after a clean preflight: nothing written, the backup holds the row', async () => {
    await seed();
    const mapping = mappingFile([owner('100100', 'groceries')]);
    const goFile = await taxonomyGo(mapping);
    const taken = backups();
    let counts: Record<string, number> = {};
    const exit = await run(importArgs(mapping, goFile), { probe: (point) => {
      if (point === 'preflighted') counts = writable((db) => RETAIL_RESERVED_FIXTURES['a correct review'](db, retailReservedBase(db, warehouseKey(1))));
    } });
    expect([exit, output()]).toEqual([1, { code: 'retail-reserved-value', ...counts }]);
    expect(taxonomyImports()).toBe(0);
    const added = backups().filter((name) => !taken.includes(name));
    expect(added).toHaveLength(1);
    expect(opened(reservedValuesStored, at(added[0]))).toEqual({ ...NO_RESERVED, correctReviews: 1 });
  });
});

describe('holdr-retail taxonomy: value-free output and the operator doc', () => {
  it('never prints a title, an item number, a department, a subject key or a natural key, from any taxonomy command', async () => {
    await seed();
    expect(await run(['taxonomy', 'worklist', '--db', file, '--out', at('worklist.json')])).toBe(0);
    const listed = retailTaxonomyWorklistOf(JSON.parse(fs.readFileSync(at('worklist.json'), 'utf8')));
    const assignments = write('assignments.json', { format: RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT, version: 1, taxonomyVersion: 2,
      generatedAt: '2031-03-01T12:00:00Z', inputs: { worklistSha256: sha256(at('worklist.json')) },
      products: listed.products.map((entry) => ({ subjectKey: entry.subjectKey, node: 'household', confidenceBp: 9_000 })) });
    expect(await run(['taxonomy', 'adopt', '--input', assignments, '--worklist', at('worklist.json'), '--out', at('adopted.json')])).toBe(0);
    expect(await run(importArgs(at('adopted.json'), await taxonomyGo(at('adopted.json'))))).toBe(0);
    expect(await importMapping([owner('100100', 'groceries'), reviewed(731, 'dining')])).toBe(0);
    await run(['taxonomy', 'plan', '--db', file, '--mapping', mappingFile([owner('100199', 'groceries')])]);
    expect(transcript).toMatch(/retail-taxonomy-imported/);
    expect(transcript).toMatch(/retail-taxonomy-subject-unknown/);
    const keys = [...listed.products.map((entry) => entry.subjectKey), ...listed.departments.map((entry) => entry.subjectKey)];
    expect(keys.filter((key) => transcript.includes(key))).toEqual([]);
    expect(valueFreeText(transcript)).not.toMatch(SENTINELS);
    expect(valueFreeText(transcript)).not.toMatch(SYNTHETIC_RETAIL_VALUES);
    expect(opened(reservedValuesStored)).toEqual(NO_RESERVED);
  });

  it('names every taxonomy command, format and code in the usage and the operator doc', () => {
    const doc = fs.readFileSync(path.join(docs, 'retail-operator.md'), 'utf8');
    for (const word of ['taxonomy worklist', 'taxonomy adopt', 'taxonomy plan', 'taxonomy import']) {
      expect(RETAIL_CLI_USAGE, word).toContain(word);
      expect(doc, word).toContain(word);
    }
    for (const word of [RETAIL_TAXONOMY_WORKLIST_FORMAT, RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT, RETAIL_TAXONOMY_MAPPING_FORMAT, 'taxonomy-import',
      'production-taxonomy', 'retail-taxonomy-worklist-written', 'retail-taxonomy-mapping-written', 'retail-taxonomy-planned',
      'retail-taxonomy-imported', 'retail-taxonomy-file-invalid', 'retail-taxonomy-node-unknown', 'retail-taxonomy-source-invalid',
      'retail-taxonomy-subject-unknown', 'retail-taxonomy-worklist-mismatch', 'decisionId', 'planDigest', 'metalHold']) {
      expect(doc, word).toContain(word);
    }
    expect(fs.readFileSync(path.join(docs, 'costco-receipts.md'), 'utf8')).toMatch(/## \d+\. Item categories: the retail taxonomy/);
  });
});
