import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { schemaSqlDigest } from '../schemaShape.js';
import {
  RETAIL_CODES,
  RETAIL_DONE_CODES,
  RETAIL_EVENT_KINDS,
  RETAIL_HELD_CLASSES,
  RETAIL_INSTALL_PLAN_DIGEST,
  RETAIL_NOTHING_CODES,
  RETAIL_OUTCOMES,
  RETAIL_OWNERS,
  RETAIL_QUARANTINE_REASONS,
  RETAIL_REFUSAL_CODES,
  RETAIL_RESERVED,
  RETAIL_REVIEW_DECISIONS,
  RETAIL_SCHEMA_DIGEST,
  RETAIL_SCHEMA_SQL,
  RETAIL_TABLES,
  RETAIL_TRIGGERS,
  RetailRefusal,
  installRetailSchema,
  newRetailId,
  retailEvidence,
  retailLetters,
  retailSchemaObjects,
  retailSchemaState,
  retailTextProblem,
  reviewRetailReceipts,
  retailEvidenceDigest,
  type RetailOwner,
} from './index.js';
import type { CardOwner } from '@finance-tracker/shared';
import { RETAIL_TEST_GO, RETAIL_TEST_NOW, importPayload, retailTestDb, rows } from '../../testing/retailDb.js';
import {
  goldBar,
  heldRecord,
  onlineLine,
  onlineOrder,
  shipment,
  syntheticRetailPayload,
  uncertainGold,
  warehouseKey,
  warehouseLine,
  warehouseReceipt,
} from '../../testing/retailPayloads.js';

// The retail schema (plan v5 §4): its states, its conflicts, every trigger and the reserved columns' CHECKs. Synthetic
// rows only, in in-memory databases.

const here = path.dirname(fileURLToPath(import.meta.url));
let db: Database.Database;

beforeEach(() => { db = retailTestDb(); });
afterEach(() => { db.close(); });

/** A payload that fills every evidence and fact table: legends, metal and flagged lines, events, shipments, tenders, holds. */
function richPayload() {
  return syntheticRetailPayload({
    receipts: [
      warehouseReceipt(1, {
        lines: [warehouseLine(0, 1_000, { metal: goldBar() }), warehouseLine(1, 500, { metalUncertain: uncertainGold() })],
        taxLegends: [{ legend: 'A', amountMinor: 120 }], taxMinor: 120,
      }),
      onlineOrder(2, { lines: [onlineLine(2, 0, 5_000, { shipments: [shipment(), shipment({ carrier: 'fedex' })] })] }),
    ],
    held: [heldRecord(), heldRecord({ naturalKey: null, check: 'record-key', reason: 'unreadable', date: null })],
  });
}

/** Quarantines receipt 1 by a changed sighting and reviews it, so a review row exists too. */
function withReview(): void {
  importPayload(db, richPayload());
  importPayload(db, syntheticRetailPayload({ capture: 'c', receipts: [warehouseReceipt(1, { date: '2031-01-12' })] }));
  const receiptRef = db.prepare('SELECT receipt_ref FROM retail_receipts WHERE natural_key = ?').pluck().get(warehouseKey(1)) as string;
  const evidence = retailEvidence(db, receiptRef);
  reviewRetailReceipts(db, { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ receiptRef, evidenceDigest: retailEvidenceDigest(evidence),
    decision: 'keep-quarantined', before: evidence.canonicalVersion, chosen: null }] },
  { now: RETAIL_TEST_NOW, authority: { kind: 'go', goId: 'b'.repeat(32), purpose: 'copy-rehearsal' }, reviewSha256: 'c'.repeat(64), planDigest: null });
}

/** What `fn` refused (a RetailRefusal), or a stand-in whose code is `none`; anything else is re-thrown unchanged. */
const refusal = (fn: () => unknown): RetailRefusal | { code: 'none' } => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RetailRefusal) return error;
    throw error;
  }
  return { code: 'none' };
};
/**
 * The SQLite constraint `fn` meets, as its code and message, or `none`. Only that declared hold type is caught; anything
 * else is re-thrown unchanged (addendum 3(e)).
 */
const constraintOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_CONSTRAINT')) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
};

describe('retail schema: state, install and conflicts', () => {
  it('is absent in a new database, present once installed, and installs once', () => {
    const fresh = new Database(':memory:');
    try {
      expect(retailSchemaState(fresh)).toBe('absent');
      expect(retailSchemaObjects(fresh)).toMatchObject({ matching: 0, differing: 0, missing: retailSchemaObjects(db).expected, unexpected: 0 });
      expect(installRetailSchema(fresh, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO }).installed).toBe(true);
      expect(retailSchemaState(fresh)).toBe('present');
      expect(installRetailSchema(fresh, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO }).installed).toBe(false);
      expect(fresh.prepare('SELECT kind, input_sha256 AS input, plan_digest AS plan, go_id AS go, purpose FROM retail_audit').all()).toEqual([
        { kind: 'install', input: null, plan: retailLetters(RETAIL_INSTALL_PLAN_DIGEST), go: retailLetters('a'.repeat(32)), purpose: 'copy-rehearsal' },
      ]);
    } finally {
      fresh.close();
    }
  });

  it('pins its digest to its statements, in the shared normalization', () => {
    expect(RETAIL_SCHEMA_DIGEST).toBe(schemaSqlDigest(RETAIL_SCHEMA_SQL));
    // Whitespace around a statement folds away; inside a quoted literal (the text CHECK's GLOBs) it is kept, by design.
    expect(RETAIL_SCHEMA_DIGEST).toBe(schemaSqlDigest(RETAIL_SCHEMA_SQL.map((sql) => `\n\t ${sql} \n`)));
    // The reviewed schema: a change to any statement must change this pin, with its review.
    expect(RETAIL_SCHEMA_DIGEST).toBe('b8931702e3cbb48efb37865749f9e1b330e221d4c0d17dc8e77979c0f6649bb1');
    // No statement carries an SQL comment: the shared normalization reads no comments, so an apostrophe in one would
    // open a quote it never closes.
    expect(RETAIL_SCHEMA_SQL.filter((sql) => /--|\/\*/.test(sql.replace(/'(?:[^']|'')*'/g, "''")))).toEqual([]);
    expect(Object.isFrozen(RETAIL_SCHEMA_SQL)).toBe(true);
    expect(RETAIL_TABLES).toHaveLength(23);
  });

  it('reports each kind of conflict, and never installs over one', () => {
    const conflicts: Array<[string, (target: Database.Database) => void, Record<string, number>]> = [
      ['an extra table', (target) => target.exec('CREATE TABLE retail_extra (id TEXT)'), { unexpected: 1 }],
      ['the prefix in other letter case', (target) => target.exec('CREATE TABLE RETAIL_Extra (id TEXT)'), { unexpected: 1 }],
      ['a view', (target) => target.exec('CREATE VIEW retail_view AS SELECT 1'), { unexpected: 1 }],
      ['an index of another name on a retail table', (target) => target.exec('CREATE INDEX other_index ON retail_held (date)'), { unexpected: 1 }],
      ['a trigger of another name on a retail table', (target) => target.exec(`CREATE TRIGGER other_trigger BEFORE INSERT ON retail_held
        BEGIN SELECT 1; END`), { unexpected: 1 }],
      ['a missing trigger', (target) => target.exec('DROP TRIGGER retail_held_no_delete'), { missing: 1 }],
    ];
    for (const [what, make, counts] of conflicts) {
      const target = retailTestDb();
      try {
        make(target);
        expect(retailSchemaState(target), what).toBe('conflict');
        expect(retailSchemaObjects(target), what).toMatchObject(counts);
        expect((refusal(() => installRetailSchema(target, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO })) as RetailRefusal).code, what)
          .toBe('retail-conflict');
      } finally {
        target.close();
      }
    }
    // Tables in another shape, down to one quoted literal: one space where the declared label CHECK has two.
    const changed = RETAIL_SCHEMA_SQL.map((sql) => sql.replace("label NOT GLOB '*  *'", "label NOT GLOB '* *'"));
    expect(changed.filter((sql, index) => sql !== RETAIL_SCHEMA_SQL[index])).toHaveLength(1);
    const other = new Database(':memory:');
    try {
      for (const sql of changed) other.exec(sql);
      expect(retailSchemaObjects(other)).toMatchObject({ differing: 1, missing: 0, unexpected: 0 });
      expect((refusal(() => installRetailSchema(other, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO })) as RetailRefusal).code).toBe('retail-conflict');
    } finally {
      other.close();
    }
  });

  it('pins the declared owners to Holdr\'s card owners', () => {
    const exact: [Exclude<CardOwner, RetailOwner>, Exclude<RetailOwner, CardOwner>] extends [never, never] ? true : false = true;
    expect(exact).toBe(true);
    expect([...RETAIL_OWNERS].sort()).toEqual(['alex', 'casey', 'joint']);
  });
});

describe('retail schema: every trigger refuses its forbidden change', () => {
  beforeEach(() => {
    withReview();
    db.prepare(`INSERT INTO retail_taxonomy_imports (taxonomy_import_id, seq, mapping_sha256, taxonomy_version, go_id, purpose, imported_at)
      VALUES (?, 1, ?, 'taxonomy-v1', ?, 'copy-rehearsal', ?)`).run(newRetailId('rtl-tax-'), 'f'.repeat(64), 'a'.repeat(32), RETAIL_TEST_NOW);
    db.prepare(`INSERT INTO retail_taxonomy_assignments (taxonomy_import_id, subject_kind, subject_key, source, node, confidence_bp)
      SELECT taxonomy_import_id, 'product', ?, 'owner', 'household/cleaning', NULL FROM retail_taxonomy_imports`).run('g'.repeat(64));
  });

  it('keeps every append-only table append-only', () => {
    const appendOnly = RETAIL_TABLES.filter((table) => !['retail_receipts', 'retail_bindings'].includes(table));
    expect(appendOnly).toHaveLength(21);
    for (const table of appendOnly) {
      expect(rows(db, `SELECT count(*) FROM ${table}`), table).toBeGreaterThan(0);
      const column = (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid LIMIT 1`).pluck().get()) as string;
      expect(() => db.exec(`UPDATE ${table} SET ${column} = ${column}`), table).toThrow(/append-only/);
      expect(() => db.exec(`DELETE FROM ${table}`), table).toThrow(/append-only/);
      expect(RETAIL_TRIGGERS).toEqual(expect.arrayContaining([`${table}_no_update`, `${table}_no_delete`]));
    }
  });

  it('keeps a receipt\'s identity, and changes its selection only to its newest event', () => {
    const receipt = db.prepare('SELECT * FROM retail_receipts WHERE natural_key = ?').get(warehouseKey(1)) as Record<string, string | number>;
    expect(() => db.prepare('UPDATE retail_receipts SET natural_key = ? WHERE receipt_ref = ?').run(warehouseKey(9), receipt.receipt_ref))
      .toThrow(/keeps its identity/);
    expect(() => db.prepare('DELETE FROM retail_receipts WHERE receipt_ref = ?').run(receipt.receipt_ref)).toThrow(/never deleted/);
    // Without an event; skipping one; or to values no newest event has.
    expect(() => db.prepare(`UPDATE retail_receipts SET state = 'active', first_reason = NULL WHERE receipt_ref = ?`).run(receipt.receipt_ref))
      .toThrow(/only by its next event/);
    expect(() => db.prepare('UPDATE retail_receipts SET selection_seq = selection_seq + 1 WHERE receipt_ref = ?').run(receipt.receipt_ref))
      .toThrow(/only by its next event/);
    const older = db.prepare('SELECT state, first_reason AS reason, canonical_version AS canonical FROM retail_receipt_events WHERE receipt_ref = ? AND seq = 1')
      .get(receipt.receipt_ref) as { state: string; reason: string | null; canonical: string };
    expect(() => db.prepare(`UPDATE retail_receipts SET state = ?, first_reason = ?, canonical_version = ? WHERE receipt_ref = ?`)
      .run(older.state, older.reason, older.canonical, receipt.receipt_ref)).toThrow(/only by its next event/);
    // A receipt starts unselected.
    const importId = db.prepare('SELECT import_id FROM retail_imports LIMIT 1').pluck().get() as string;
    expect(() => db.prepare(`INSERT INTO retail_receipts (receipt_ref, merchant, channel, natural_key, first_import, state, first_reason,
      canonical_version, selection_seq) VALUES (?, 'costco', 'warehouse', ?, ?, 'active', NULL, ?, 1)`)
      .run(newRetailId('rcp-'), warehouseKey(8), importId, receipt.canonical_version)).toThrow(/starts unselected/);
  });

  it('chains each event to the receipt\'s current selection and lets it cite only its own receipt\'s evidence', () => {
    const one = db.prepare('SELECT * FROM retail_receipts WHERE natural_key = ?').get(warehouseKey(1)) as Record<string, string | number>;
    const two = db.prepare(`SELECT * FROM retail_receipts WHERE channel = 'online'`).get() as Record<string, string | number>;
    const observation = (receiptRef: unknown) => db.prepare(
      'SELECT observation_ref AS ref, import_id AS importId, version_ref AS version FROM retail_receipt_observations WHERE receipt_ref = ? ORDER BY rowid')
      .all(receiptRef) as Array<{ ref: string; importId: string; version: string }>;
    const [first, second] = observation(one.receipt_ref);
    const [online] = observation(two.receipt_ref);
    const heldRef = db.prepare('SELECT held_ref FROM retail_held WHERE natural_key IS NOT NULL').pluck().get() as string;
    const event = (patch: Record<string, unknown>) => {
      const row = {
        receipt_ref: one.receipt_ref, seq: Number(one.selection_seq) + 1, kind: 'cause', prior_version: one.canonical_version, state: 'quarantined',
        first_reason: one.first_reason, canonical_version: one.canonical_version, reason: 'receipt-changed', observation_ref: second.ref, held_ref: null,
        review_ref: null, import_id: second.importId, go_id: null, witness_observation_ref: null, progression_rule: null, at: RETAIL_TEST_NOW, ...patch,
      };
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO retail_receipt_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
    };
    const chain = /follows the receipt's current selection/;
    const own = /cites only its own receipt's evidence/;
    expect(() => event({ seq: Number(one.selection_seq) + 2 })).toThrow(chain);
    expect(() => event({ prior_version: second.version === one.canonical_version ? first.version : second.version })).toThrow(/current selection|FOREIGN KEY/);
    expect(() => event({ observation_ref: online.ref, import_id: online.importId })).toThrow(own);
    expect(() => event({ import_id: first.importId, observation_ref: second.ref })).toThrow(own);
    expect(() => event({ observation_ref: null, held_ref: heldRef, import_id: first.importId, reason: 'receipt-held-later' })).toThrow(own);
    // A progression's witness must be a sighting of its prior version (reserved kind; schema-valid otherwise).
    expect(() => event({ kind: 'progression', reason: null, state: 'active', first_reason: null, canonical_version: second.version,
      witness_observation_ref: second.ref, progression_rule: 'retail-progression-v1' })).toThrow(own);
  });

  it('keeps a version\'s facts on refs of its own receipt and line', () => {
    const versionOf = (key: string) => db.prepare(`SELECT canonical_version FROM retail_receipts WHERE natural_key = ?`).pluck().get(key) as string;
    const onlineVersion = db.prepare(`SELECT canonical_version FROM retail_receipts WHERE channel = 'online'`).pluck().get() as string;
    const warehouseLineRef = db.prepare(`SELECT line_ref FROM retail_line_refs WHERE ordinal = 0`).pluck().get() as string;
    expect(() => db.prepare(`INSERT INTO retail_line_facts (version_ref, line_ref, ordinal, kind, amount_minor) VALUES (?, ?, 7, 'item', 1)`)
      .run(onlineVersion, warehouseLineRef)).toThrow(/line of its own receipt/);
    expect(() => db.prepare(`INSERT INTO retail_line_facts (version_ref, line_ref, ordinal, kind, amount_minor) VALUES (?, ?, 7, 'item', 1)`)
      .run(versionOf(warehouseKey(1)), warehouseLineRef)).toThrow(/line of its own receipt/);
    const [shipmentA, shipmentB] = db.prepare('SELECT shipment_ref FROM retail_shipment_refs').pluck().all() as string[];
    expect(shipmentB).toBeDefined();
    const tender = db.prepare(`SELECT t.tender_ref FROM retail_tender_refs t JOIN retail_receipts r ON r.receipt_ref = t.receipt_ref
      WHERE r.channel = 'online'`).pluck().get() as string;
    expect(() => db.prepare(`INSERT INTO retail_tender_facts (version_ref, tender_ref, ordinal, kind, network, last4, amount_minor)
      VALUES (?, ?, 5, 'cash', 'unknown', NULL, 1)`).run(versionOf(warehouseKey(1)), tender)).toThrow(/tender of its own receipt/);
    const onlineLine = db.prepare(`SELECT line_ref FROM retail_line_refs WHERE line_key IS NOT NULL`).pluck().get() as string;
    const otherLine = newRetailId('rli-');
    db.pragma('foreign_keys = OFF');
    expect(() => db.prepare(`INSERT INTO retail_shipment_facts (version_ref, shipment_ref, line_ref, position) VALUES (?, ?, ?, 9)`)
      .run(onlineVersion, shipmentA, otherLine)).toThrow(/shipment of its own line/);
    db.pragma('foreign_keys = ON');
    expect(onlineLine).toMatch(/^rli-/);
  });

  it('changes a binding only from active to revoked, once, and never deletes it', () => {
    const binding = newRetailId('rtl-bind-');
    const insert = (id: string) => db.prepare(`INSERT INTO retail_bindings (binding_id, merchant, network, last4, card_account_id, card_facts_digest,
      proposal_sha256, inventory_digest, policy_digest, approved_go, approved_at, state, revoked_go, revoked_at)
      VALUES (?, 'costco', 'visa', '0011', 'card-sample', ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`)
      .run(id, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(32), RETAIL_TEST_NOW);
    insert(binding);
    expect(() => insert(newRetailId('rtl-bind-'))).toThrow(/UNIQUE/);
    expect(() => db.prepare(`UPDATE retail_bindings SET last4 = '0042' WHERE binding_id = ?`).run(binding)).toThrow(/keeps its approval/);
    expect(() => db.prepare(`DELETE FROM retail_bindings WHERE binding_id = ?`).run(binding)).toThrow(/never deleted/);
    db.prepare(`UPDATE retail_bindings SET state = 'revoked', revoked_go = ?, revoked_at = ? WHERE binding_id = ?`).run('f'.repeat(32), RETAIL_TEST_NOW, binding);
    expect(() => db.prepare(`UPDATE retail_bindings SET state = 'active', revoked_go = NULL, revoked_at = NULL WHERE binding_id = ?`).run(binding))
      .toThrow(/revoked once/);
  });
});

describe('retail schema: the reserved event columns (plan §5.7)', () => {
  it('sets both reserved columns on a progression event only: either one set elsewhere, or missing on one, is refused', () => {
    importPayload(db, syntheticRetailPayload());
    const receipt = db.prepare('SELECT * FROM retail_receipts').get() as Record<string, string | number>;
    const sighting = db.prepare('SELECT observation_ref AS ref, import_id AS importId FROM retail_receipt_observations').get() as { ref: string; importId: string };
    const insert = (patch: Record<string, unknown>) => db.prepare(`INSERT INTO retail_receipt_events (receipt_ref, seq, kind, prior_version, state,
      first_reason, canonical_version, reason, observation_ref, held_ref, review_ref, import_id, go_id, witness_observation_ref, progression_rule, at)
      VALUES (@receipt_ref, @seq, @kind, @prior, 'active', NULL, @canonical, NULL, @observation, NULL, NULL, @import, NULL, @witness, @rule, @at)`).run({
      receipt_ref: receipt.receipt_ref, seq: 2, kind: 'progression', prior: receipt.canonical_version, canonical: receipt.canonical_version,
      observation: sighting.ref, import: sighting.importId, witness: sighting.ref, rule: 'retail-progression-v1', at: RETAIL_TEST_NOW, ...patch,
    });
    // Set on another kind, or a rule of another shape: the CHECKs refuse (every trigger lets these through).
    for (const patch of [{ rule: null }, { kind: 'provenance-refresh' }, { kind: 'provenance-refresh', rule: null },
      { kind: 'provenance-refresh', witness: null }, { rule: 'retail-progression-v0' }, { rule: 'retail-progression-x1' }]) {
      expect(constraintOf(() => insert(patch)), JSON.stringify(patch)).toMatch(/^SQLITE_CONSTRAINT_CHECK: CHECK constraint failed/);
    }
    // A progression with no witness: refused too (the cite-own trigger, which needs a prior-version witness, comes first).
    expect(constraintOf(() => insert({ witness: null }))).toBe("SQLITE_CONSTRAINT_TRIGGER: a retail receipt event cites only its own receipt's evidence");
    expect(rows(db, 'SELECT count(*) FROM retail_receipt_events')).toBe(1);
  });
});

describe('retail schema: the free-text CHECK and its mirror in the storage check (draft note 3)', () => {
  it('accepts and refuses exactly the same values as retailTextProblem, on one corpus', () => {
    const corpus = [
      'A', 'SAMPLE WIDGET 12 PK', 'x'.repeat(40), 'x'.repeat(41), '', ' A', 'A ', 'A  B', 'A\tB', 'A\nB', 'A\u0000B', 'A\u007fB', 'A\u0085B',
      'A\u00a0B', 'A\u1680B', 'A\u2000B', 'A\u200aB', 'A\u200bB', 'A\u2028B', 'A\u202fB', 'A\u205fB', 'A\u3000B', 'A\ufeffB', '\u00b2', '\uff11',
      '=A', '+A', '-A', '@A', 'A=', `${'1'.repeat(12)}`, `${'1'.repeat(13)}`, 'é', '\u{1F600}', 'caf\u0065\u0301',
    ];
    db.pragma('foreign_keys = OFF');
    const versionRef = newRetailId('rrv-');
    corpus.forEach((value, position) => {
      let stored = true;
      try {
        db.prepare('INSERT INTO retail_tax_legends (version_ref, position, legend, amount_minor) VALUES (?, ?, ?, 0)').run(versionRef, position % 20, value);
      } catch (error) {
        if (!(error instanceof Database.SqliteError)) throw error;
        stored = false;
      }
      expect(stored, JSON.stringify(value)).toBe(retailTextProblem(value, 40) === null);
      if (stored) {
        // Remove it again, through the declared trigger's own drop and re-creation, so the next value finds its position free.
        db.exec('DROP TRIGGER retail_tax_legends_no_delete');
        db.prepare('DELETE FROM retail_tax_legends').run();
        db.exec(RETAIL_SCHEMA_SQL.find((sql) => sql.startsWith('CREATE TRIGGER retail_tax_legends_no_delete'))!);
      }
    });
    expect(retailSchemaState(db)).toBe('present');
  });
});

describe('retail isolation: the API reads the payload contract, never the converter', () => {
  it('imports the payload subpath only, in every retail module and the CLI', () => {
    const sources = [
      ...fs.readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => path.join(here, name)),
      ...['retail.ts', 'retailMain.ts', 'retailReport.ts'].map((name) => path.join(here, '..', '..', 'cli', name)),
    ];
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/retail-import-tool|retail-capture-fixtures|retailImportTool\//);
    }
    expect(fs.readFileSync(path.join(here, 'schema.ts'), 'utf8')).toMatch(/from '@finance-tracker\/shared\/retail-import-payload'/);
  });
});

describe('retail vocabularies: one source each, pinned to plan v5 section 9', () => {
  it('pins every closed vocabulary and code set, and finds no code literal in the sources outside the one list', () => {
    expect([...RETAIL_DONE_CODES]).toEqual(['retail-planned', 'retail-declaration-valid', 'retail-previewed', 'retail-installed', 'retail-imported',
      'retail-quarantine-listed', 'retail-reviewed', 'retail-bindings-proposed', 'retail-reported', 'retail-taxonomy-worklist-written',
      'retail-taxonomy-mapping-written', 'retail-taxonomy-planned', 'retail-taxonomy-imported']);
    expect([...RETAIL_NOTHING_CODES]).toEqual(['retail-already-installed', 'retail-already-imported', 'retail-already-reviewed']);
    expect([...RETAIL_REFUSAL_CODES].sort()).toEqual(['retail-conflict', 'retail-not-installed', 'retail-no-shared-lease', 'retail-go-invalid',
      'retail-go-id-invalid', 'retail-purpose-invalid', 'retail-input-mismatch', 'retail-payload-too-large', 'retail-payload-not-canonical',
      'retail-payload-invalid', 'retail-payload-unstorable', 'retail-declaration-invalid', 'retail-declaration-mismatch',
      'retail-membership-undeclared', 'retail-membership-declared-twice', 'retail-membership-unknown', 'retail-membership-conflict',
      'retail-receipt-conflict', 'retail-plan-changed', 'retail-review-invalid', 'retail-review-stale', 'retail-receipt-unknown', 'retail-receipt-not-quarantined',
      'retail-path-not-absolute', 'retail-output-exists', 'retail-output-not-owner-only', 'retail-output-uncheckable', 'retail-output-name-refused',
      'retail-clone-is-source', 'retail-digest-invalid', 'retail-time-invalid', 'retail-reserved-value', 'retail-taxonomy-file-invalid',
      'retail-taxonomy-node-unknown', 'retail-taxonomy-source-invalid', 'retail-taxonomy-subject-unknown', 'retail-taxonomy-worklist-mismatch'].sort());
    expect([...RETAIL_CODES]).toEqual([...RETAIL_DONE_CODES, ...RETAIL_NOTHING_CODES, ...RETAIL_REFUSAL_CODES]);
    expect(new Set(RETAIL_CODES).size).toBe(RETAIL_CODES.length);
    expect([...RETAIL_QUARANTINE_REASONS]).toEqual(['duplicate-across-memberships', 'receipt-changed', 'policy-reread-changed', 'receipt-held-later']);
    expect([...RETAIL_EVENT_KINDS]).toEqual(['created', 'quarantined', 'cause', 'provenance-refresh', 'review', 'progression']);
    expect([...RETAIL_OUTCOMES]).toEqual(['new', 'quarantined', 'conflict', 'changed', 'policy-reread', 'provenance-refresh', 'older-policy',
      'unchanged', 'shared', 'progression']);
    expect([...RETAIL_REVIEW_DECISIONS]).toEqual(['canonical', 'keep-quarantined', 'correct']);
    expect([...RETAIL_HELD_CLASSES]).toEqual(['no-key', 'pending', 'quarantining']);
    expect(RETAIL_RESERVED).toEqual({ outcome: 'progression', eventKind: 'progression', decision: 'correct', countColumn: 'progression_count',
      eventColumns: ['witness_observation_ref', 'progression_rule'] });
    const sources = [
      ...fs.readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => path.join(here, name)),
      ...['retail.ts', 'retailMain.ts', 'retailReport.ts'].map((name) => path.join(here, '..', '..', 'cli', name)),
    ];
    const literals = new Set(sources.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/'(retail-[a-z0-9-]+)'/g)].map((match) => match[1])));
    expect([...literals].filter((literal) => !(RETAIL_CODES as readonly string[]).includes(literal))).toEqual(['retail-progression-']);
  });
});
