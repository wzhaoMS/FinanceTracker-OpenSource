import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';

import type { MetalsOrder } from '@finance-tracker/shared/metals-ledger';
import { delivered, metalItem, syntheticCoverage, syntheticOrder, syntheticPayload } from '@finance-tracker/shared/metals-ledger-fixtures';

import { importMetalsPayload, installMetalsSchema, metalsPayloadSha256 } from '../metals/index.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { MetalsCorrectionUnsupported, MetalsReadModel, MetalsSchemaClosed, metalsCorrectionPresent } from './source.js';

// Synthetic only: invented orders and amounts on scratch databases this build made, through the real install and
// import (G2); each correction state is then written by direct SQL, as only a v1 command would write it.

const NOW = '2030-03-20T16:00:00.000Z';
const LETTERS_32 = 'abcdefghijklmnop'.repeat(2);
const LETTERS_64 = LETTERS_32.repeat(2);
/** The quarantine marker exactly as corrections r6 §1's template (a correction reason, its GO, since, no ref, a nonce). */
const QUARANTINE_MARKER = `CREATE VIEW metals_quarantine AS SELECT 'import-wrong-payload' AS reason, '${'d'.repeat(32)}' AS go_id, `
  + `'${NOW}' AS since, '' AS ref, '${'e'.repeat(32)}' AS nonce`;

let dir: string;
let repos: SqliteStateRepo[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metals-tripwire-'));
  repos = [];
});

afterEach(() => {
  for (const repo of repos) repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Walmart order of one 1 ozt gold bar, by one card, delivered four days after it was ordered. */
function walmartBar(id: string, date: string): MetalsOrder {
  const deliveredOn = new Date(Date.parse(`${date}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
  return syntheticOrder({
    source: 'walmart', channel: 'online', id, date,
    skeleton: [metalItem(0, 200000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000,
    },
    lines: [{
      ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', productRef: 'walmart:100001', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'ozt' }, pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null,
      quantity: 1, unitPriceMinor: 200000, events: [delivered(1, deliveredOn)], seller: 'Sample Bullion Shop',
    }],
  });
}

const FIRST = walmartBar('t1', '2030-01-10');
const SECOND = walmartBar('t2', '2030-02-10');

/** A new scratch ledger: the install, then two imports of one account (FIRST, then SECOND), with no correction. */
function ledger(): { db: Database; repo: SqliteStateRepo; file: string; first: string; second: string; account: string } {
  const file = path.join(dir, `ledger-${repos.length}.db`);
  const repo = new SqliteStateRepo({ file });
  repos.push(repo);
  const db = repo.internalGetDb();
  installMetalsSchema(db);
  const importOne = (order: MetalsOrder, minute: number, account: { label: string } | { accountId: string }) => {
    const payload = syntheticPayload('walmart', { orders: [order], coverage: [syntheticCoverage('online', '2029-01-01', '2030-03-19', 1, 1)] });
    const receipt = importMetalsPayload(db, { payload, account }, { now: `2030-03-20T12:0${minute}:00.000Z`, goId: randomBytes(16).toString('hex'),
      purpose: 'copy-rehearsal', inputSha256: metalsPayloadSha256(payload), planDigest: null });
    expect(receipt.code).toBe('metals-imported');
    return receipt;
  };
  const first = importOne(FIRST, 0, { label: 'Walmart account' });
  const second = importOne(SECOND, 1, { accountId: first.accountId! });
  const importId = (seq: number) => db.prepare('SELECT import_id FROM metals_imports WHERE import_seq = ?').pluck().get(seq) as string;
  return { db, repo, file, first: importId(1), second: importId(2), account: first.accountId! };
}

/** A stored row of the table, copied with the given fields, at the next rowid (as G2's writers allocate one). */
function insertLike(db: Database, table: string, where: string, fields: Record<string, unknown>): void {
  const row = { ...(db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`).get() as Record<string, unknown>), ...fields };
  const columns = Object.keys(row);
  const rowid = db.prepare(`SELECT coalesce(max(rowid), 0) + 1 FROM ${table}`).pluck().get() as number;
  db.prepare(`INSERT INTO ${table} (rowid, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`)
    .run(rowid, ...columns.map((column) => row[column]));
}

describe('metals read source: the correction tripwire, clause by clause', () => {
  it('finds each correction state alone, on a ledger with no void, through its own clause', () => {
    // The control: a ledger with no correction state reads as readable.
    expect(metalsCorrectionPresent(ledger().db)).toBe(false);

    // An import voided (every void field at once, one way), as void-import writes it.
    const voidedImport = ledger();
    voidedImport.db.prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-payload', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-payload' WHERE import_id = ?`).run(LETTERS_32, NOW, LETTERS_64, voidedImport.second);
    expect(metalsCorrectionPresent(voidedImport.db)).toBe(true);

    // An import that corrects another (the correction import names the void it follows).
    const correction = ledger();
    insertLike(correction.db, 'metals_imports', `import_id = '${correction.second}'`, {
      import_id: `mtl-imp-${LETTERS_32}`, import_seq: 3, payload_sha256: LETTERS_64, imported_at: NOW, corrects_import: correction.first,
    });
    expect(metalsCorrectionPresent(correction.db)).toBe(true);

    // A version a void voided: superseded, resolution voided, with the void's GO.
    const voidedVersion = ledger();
    voidedVersion.db.prepare(`UPDATE metals_order_versions SET state = 'superseded', resolution = 'voided', resolved_by_go = ?, resolved_at = ?
      WHERE order_key = ? AND version = 1`).run(LETTERS_32, NOW, FIRST.key);
    expect(metalsCorrectionPresent(voidedVersion.db)).toBe(true);

    // An order renewed after a full void (a new version above 1, reason renewed).
    const renewed = ledger();
    insertLike(renewed.db, 'metals_order_versions', `order_key = '${FIRST.key}' AND version = 1`,
      { version: 2, state: 'proposed', reason: 'renewed', created_at: NOW });
    expect(metalsCorrectionPresent(renewed.db)).toBe(true);

    // A copy a void reinstated (naming the version it copies, with the void's GO).
    const reinstated = ledger();
    insertLike(reinstated.db, 'metals_order_versions', `order_key = '${FIRST.key}' AND version = 1`,
      { version: 2, state: 'proposed', reason: 'reinstated', reinstates_version: 1, reinstated_by_go: LETTERS_32, created_at: NOW });
    expect(metalsCorrectionPresent(reinstated.db)).toBe(true);

    // An import's observation of a renewal.
    const observed = ledger();
    insertLike(observed.db, 'metals_observations', `import_id = '${observed.first}' AND order_key = '${FIRST.key}'`,
      { import_id: observed.second, outcome: 'renewed' });
    expect(metalsCorrectionPresent(observed.db)).toBe(true);
  });
});

describe('metals read model: the tripwire is asked in the graph\'s own read snapshot', () => {
  it('refuses a correction another connection commits after the caller\'s checks, and the model gives nothing', () => {
    const scratch = ledger();
    const model = new MetalsReadModel(scratch.repo);
    expect(model.schemaState()).toBe('present');
    expect(model.graph().decisions).toEqual([]);
    const other = new BetterSqlite3(scratch.file);
    other.prepare(`UPDATE metals_imports SET voided_by_go = ?, voided_at = ?, void_reason = 'wrong-payload', voided_under_marker = ?,
      voided_under_reason = 'import-wrong-payload' WHERE import_id = ?`).run(LETTERS_32, NOW, LETTERS_64, scratch.second);
    other.close();
    // Only the model's own refusal is caught, as data: by its constructor, name and exact words (the allowlist, kill
    // standard §8 and §9a). Anything else is re-thrown as it is, so no other error can pass for this test's assertion.
    let read: string;
    try {
      model.graph();
      read = 'read';
    } catch (error) {
      const refusal = error instanceof MetalsCorrectionUnsupported && error.constructor === MetalsCorrectionUnsupported
        && error.name === 'MetalsCorrectionUnsupported' && error.message === 'correction-unsupported';
      if (!refusal) throw error;
      read = error.message;
    }
    expect(read).toBe('correction-unsupported');
    expect(model.receiptCharges()).toEqual([]);
    expect(model.chargeParts('card-row')).toEqual({ provable: false, reason: 'not-linked' });
    expect(model.depositEvidence()).toEqual([]);
  });

  it('refuses the quarantine marker another connection sets after the caller\'s checks, as every state but present', () => {
    const scratch = ledger();
    const model = new MetalsReadModel(scratch.repo);
    expect(model.schemaState()).toBe('present');
    expect(model.graph().decisions).toEqual([]);
    const other = new BetterSqlite3(scratch.file);
    other.exec(QUARANTINE_MARKER);
    other.close();
    // As above: only the model's own refusal is caught, by its constructor, name and exact words; anything else is re-thrown.
    let read: string;
    try {
      model.graph();
      read = 'read';
    } catch (error) {
      const refusal = error instanceof MetalsSchemaClosed && error.constructor === MetalsSchemaClosed && error.name === 'MetalsSchemaClosed'
        && error.message === 'schema-closed';
      if (!refusal) throw error;
      read = error.message;
    }
    expect(read).toBe('schema-closed');
    expect(model.receiptCharges()).toEqual([]);
  });
});
