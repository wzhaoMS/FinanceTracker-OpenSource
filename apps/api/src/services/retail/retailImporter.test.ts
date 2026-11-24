import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { RetailImportPayload, RetailImportReceipt } from '@finance-tracker/shared/retail-import-payload';

import {
  RETAIL_SCHEMA_SQL,
  importRetailPayload,
  planRetailImport,
  retailEvidence,
  retailEvidenceDigest,
  retailPayloadSha256,
  reviewRetailReceipts,
  validRetailPayload,
  type RetailImportResult,
} from './index.js';
import {
  LATER_LABELS,
  RETAIL_TEST_GO,
  RETAIL_TEST_NOW,
  declaration,
  importPayload,
  membershipChoice,
  refusalOf,
  retailTestDb,
  rows,
  seedLaterSighting,
} from '../../testing/retailDb.js';
import {
  SYNTHETIC_RETAIL,
  goldBar,
  heldRecord,
  onlineLine,
  onlineOrder,
  orderKey,
  shipment,
  syntheticRetailPayload,
  warehouseKey,
  warehouseLine,
  warehouseReceipt,
} from '../../testing/retailPayloads.js';

// The importer (plan v5 §5) end to end on in-memory databases: outcomes, memberships, refs, holds and the fenced write.
// Synthetic payloads only.

let db: Database.Database;
let capture = 0;
beforeEach(() => { db = retailTestDb(); capture = 0; });
afterEach(() => { db.close(); });

/** A payload of its own capture (each import here is another file), of membership folder `folder`. */
const payloadOf = (receipts: RetailImportReceipt[], options: Parameters<typeof syntheticRetailPayload>[0] = {}): RetailImportPayload =>
  syntheticRetailPayload({ capture: 'bcdefghijklmnop'[capture++ % 15], receipts, ...options });
const load = (target: Database.Database, receipts: RetailImportReceipt[], options: Parameters<typeof syntheticRetailPayload>[0] = {}) =>
  importPayload(target, payloadOf(receipts, options));
const receiptOf = (key: string, target = db) => target.prepare(`SELECT receipt_ref AS ref, state, first_reason AS firstReason,
  canonical_version AS canonical, selection_seq AS seq FROM retail_receipts WHERE natural_key = ?`).get(key) as
  { ref: string; state: string; firstReason: string | null; canonical: string; seq: number };
const eventsOf = (key: string, target = db) => target.prepare(`SELECT e.kind, e.reason, e.state FROM retail_receipt_events e
  JOIN retail_receipts r ON r.receipt_ref = e.receipt_ref WHERE r.natural_key = ? ORDER BY e.seq`).all(key) as
  Array<{ kind: string; reason: string | null; state: string }>;
const outcomeOf = (result: RetailImportResult) =>
  Object.entries(result.outcomes).filter(([, count]) => count > 0).map(([outcome, count]) => `${outcome}:${count}`).join(',');
const membershipRef = (folder: string) => db.prepare('SELECT membership_ref FROM retail_memberships WHERE folder = ?').pluck().get(folder) as string;
/** Reviews one quarantined receipt (`canonical` on `chosen`, or keep it quarantined), as an owner's file would. */
function review(key: string, chosen: string | null, sha = 'e'.repeat(64)) {
  const receipt = receiptOf(key);
  return reviewRetailReceipts(db, { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ receiptRef: receipt.ref,
    evidenceDigest: retailEvidenceDigest(retailEvidence(db, receipt.ref)), decision: chosen === null ? 'keep-quarantined' : 'canonical',
    before: receipt.canonical, chosen }] }, { now: RETAIL_TEST_NOW, authority: { kind: 'go', goId: 'f'.repeat(32), purpose: 'copy-rehearsal' },
    reviewSha256: sha, planDigest: null });
}
/** Changes stored facts with their append-only trigger lifted and put back as declared: a version whose facts and digests disagree. */
function tamper(table: string, sql: string): void {
  db.exec(`DROP TRIGGER ${table}_no_update`);
  db.exec(sql);
  db.exec(RETAIL_SCHEMA_SQL.find((statement) => statement.startsWith(`CREATE TRIGGER ${table}_no_update `))!);
}

describe('retail import: plan, write and the same payload again (plan §5.1, §5.6)', () => {
  it('plans read-only, writes one import with its membership, facts and receipt, and writes nothing for the same payload again', () => {
    const payload = payloadOf([warehouseReceipt(1)], { folder: 'costco-2' });
    const declared = declaration('costco-2', 'joint');
    const request = { payload, declaration: declared, membership: membershipChoice(db, payload, declared) };
    const plan = planRetailImport(db, request);
    expect(plan).toMatchObject({ alreadyImported: false, importId: null, membership: { kind: 'register', declarationSha256: declared.sha256 },
      receipts: 1, outcomes: { new: 1, quarantined: 0, conflict: 0, changed: 0, 'policy-reread': 0, 'provenance-refresh': 0, 'older-policy': 0,
        unchanged: 0, shared: 0 }, held: { 'no-key': 0, pending: 0, quarantining: 0 }, possibleOverlap: 0, cardLast4sUnbound: 1 });
    expect(Object.keys(plan.outcomes)).toHaveLength(9);
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(0);
    const result = importRetailPayload(db, request, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO,
      inputSha256: retailPayloadSha256(validRetailPayload(payload)), planDigest: plan.planDigest });
    expect(result).toMatchObject({ code: 'retail-imported', importSeq: 1, planDigest: plan.planDigest, membership: { kind: 'registered' } });
    expect(db.prepare('SELECT folder, owner, label FROM retail_memberships').all()).toEqual([{ folder: 'costco-2', owner: 'joint', label: 'Sample Household' }]);
    expect(db.prepare('SELECT field, value FROM retail_membership_facts ORDER BY field').all()).toEqual([
      { field: 'member-since-year', value: SYNTHETIC_RETAIL.memberSinceYear }, { field: 'membership-last4', value: SYNTHETIC_RETAIL.memberLast4 },
      { field: 'tier', value: SYNTHETIC_RETAIL.tier }]);
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'active', firstReason: null, seq: 1 });
    expect(eventsOf(warehouseKey(1))).toEqual([{ kind: 'created', reason: null, state: 'active' }]);
    expect(db.prepare(`SELECT captured_at FROM retail_imports`).pluck().get()).toBe('2031-02-03T04:05:06.000Z');
    expect(db.prepare(`SELECT kind FROM retail_audit ORDER BY seq`).pluck().all()).toEqual(['install', 'import']);
    const again = importRetailPayload(db, { ...request, declaration: null, membership: { membershipRef: membershipRef('costco-2') } },
      { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, inputSha256: retailPayloadSha256(validRetailPayload(payload)), planDigest: null });
    expect(again).toMatchObject({ code: 'retail-already-imported', importId: result.importId, importSeq: null });
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(1);
  });

  it('refuses another payload than the GO names, and a plan that changed between the preflight and the write, writing nothing', () => {
    load(db, [warehouseReceipt(1)]);
    const payload = payloadOf([warehouseReceipt(1, { date: '2031-01-12' })]);
    const request = { payload, declaration: null, membership: membershipChoice(db, payload, null) };
    const inputSha256 = retailPayloadSha256(validRetailPayload(payload));
    const plan = planRetailImport(db, request);
    expect(refusalOf(() => importRetailPayload(db, request, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, inputSha256: 'a'.repeat(64),
      planDigest: plan.planDigest })).code).toBe('retail-input-mismatch');
    // The database moves: another sighting of the same receipt lands first.
    load(db, [warehouseReceipt(1)]);
    const before = rows(db, 'SELECT count(*) FROM retail_imports');
    expect(refusalOf(() => importRetailPayload(db, request, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, inputSha256,
      planDigest: plan.planDigest })).code).toBe('retail-plan-changed');
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(before);
    expect(refusalOf(() => importRetailPayload(db, { ...request, membership: null }, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, inputSha256,
      planDigest: null })).code).toBe('retail-go-invalid');
    for (const [context, code] of [
      [{ now: '2031-02-30T00:00:00.000Z', authority: RETAIL_TEST_GO }, 'retail-time-invalid'],
      [{ now: RETAIL_TEST_NOW, authority: { kind: 'go', goId: 'A'.repeat(32), purpose: 'copy-rehearsal' } }, 'retail-go-id-invalid'],
      [{ now: RETAIL_TEST_NOW, authority: { kind: 'go', goId: 'a'.repeat(32), purpose: 'production-install' } }, 'retail-purpose-invalid'],
    ] as const) {
      expect(refusalOf(() => importRetailPayload(db, request, { ...context, inputSha256, planDigest: null })).code).toBe(code);
    }
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(before);
  });
});

describe('retail import: §5.3 outcomes end to end, in both arrival orders', () => {
  it('observes an unchanged re-read, and shares an identical receipt with another membership as one receipt', () => {
    load(db, [warehouseReceipt(1)]);
    expect(outcomeOf(load(db, [warehouseReceipt(1)]))).toBe('unchanged:1');
    expect(outcomeOf(load(db, [warehouseReceipt(1)], { folder: 'costco-2' }))).toBe('shared:1');
    expect(rows(db, 'SELECT count(*) FROM retail_receipts')).toBe(1);
    expect(rows(db, 'SELECT count(*) FROM retail_receipt_versions')).toBe(1);
    expect(rows(db, 'SELECT count(DISTINCT membership_ref) FROM retail_receipt_observations')).toBe(2);
    expect(rows(db, 'SELECT count(*) FROM retail_receipt_observations')).toBe(3);
    expect(eventsOf(warehouseKey(1))).toEqual([{ kind: 'created', reason: null, state: 'active' }]);
  });

  it('quarantines a different capture from another membership (conflict) or the same one (changed), whichever arrived first', () => {
    const a = warehouseReceipt(1);
    const b = warehouseReceipt(1, { lines: [warehouseLine(0, 1_200)] });
    for (const [first, second] of [[a, b], [b, a]]) {
      for (const [folder, outcome, reason] of [['costco-2', 'conflict:1', 'duplicate-across-memberships'], ['costco', 'changed:1', 'receipt-changed']]) {
        const target = retailTestDb();
        try {
          importPayload(target, payloadOf([first]));
          const canonical = receiptOf(warehouseKey(1), target).canonical;
          expect(outcomeOf(importPayload(target, payloadOf([second], { folder })))).toBe(outcome);
          expect(receiptOf(warehouseKey(1), target)).toMatchObject({ state: 'quarantined', firstReason: reason, canonical });
          expect(eventsOf(warehouseKey(1), target)).toEqual([{ kind: 'created', reason: null, state: 'active' },
            { kind: 'quarantined', reason, state: 'quarantined' }]);
          expect(rows(target, 'SELECT count(*) FROM retail_receipt_versions')).toBe(2);
        } finally {
          target.close();
        }
      }
    }
  });

  it('holds the same policy with another meaning as changed, and on a quarantined receipt adds a cause only for a quarantining version', () => {
    load(db, [warehouseReceipt(1)]);
    const metal = warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] });
    expect(outcomeOf(load(db, [metal]))).toBe('changed:1');
    expect(receiptOf(warehouseKey(1)).firstReason).toBe('receipt-changed');
    // Identical to the canonical: an observation, no cause. The quarantining version seen again: one more cause (§6).
    expect(outcomeOf(load(db, [warehouseReceipt(1)]))).toBe('quarantined:1');
    expect(eventsOf(warehouseKey(1))).toHaveLength(2);
    expect(outcomeOf(load(db, [metal]))).toBe('quarantined:1');
    expect(eventsOf(warehouseKey(1))).toHaveLength(3);
    // A version the canonical doesn't match: one more cause, the first reason kept.
    expect(outcomeOf(load(db, [warehouseReceipt(1, { date: '2031-01-12' })], { folder: 'costco-2' }))).toBe('quarantined:1');
    expect(eventsOf(warehouseKey(1)).slice(3)).toEqual([{ kind: 'cause', reason: 'duplicate-across-memberships', state: 'quarantined' }]);
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'quarantined', firstReason: 'receipt-changed' });
  });

  it('reads an older policy\'s labels-only re-read as an observation and its meaningful re-read as held, the canonical kept (B then A)', () => {
    load(db, [warehouseReceipt(9)]);
    const member = membershipRef('costco');
    // B: read under a later policy, no metal; stored first, as a later build would.
    const later = seedLaterSighting(db, member, warehouseReceipt(1), LATER_LABELS);
    expect(outcomeOf(load(db, [warehouseReceipt(1)]))).toBe('older-policy:1');
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'active', canonical: later.versionRef });
    // A: older and metal, same source: held, the canonical still B's.
    expect(outcomeOf(load(db, [warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] })]))).toBe('policy-reread:1');
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'quarantined', firstReason: 'policy-reread-changed', canonical: later.versionRef });
    // A source difference under an older policy is changed (§5.3 row 4), never a re-read.
    const other = seedLaterSighting(db, member, warehouseReceipt(2), LATER_LABELS);
    expect(outcomeOf(load(db, [warehouseReceipt(2, { date: '2031-01-12' })]))).toBe('changed:1');
    expect(receiptOf(warehouseKey(2))).toMatchObject({ firstReason: 'receipt-changed', canonical: other.versionRef });
  });

  it('holds an older meaningful sighting again after a review, with a new cause', () => {
    load(db, [warehouseReceipt(9)]);
    const later = seedLaterSighting(db, membershipRef('costco'), warehouseReceipt(1), LATER_LABELS);
    const metal = warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] });
    expect(outcomeOf(load(db, [metal]))).toBe('policy-reread:1');
    review(warehouseKey(1), later.versionRef);
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'active', canonical: later.versionRef });
    expect(outcomeOf(load(db, [metal]))).toBe('policy-reread:1');
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'quarantined', firstReason: 'policy-reread-changed' });
    expect(eventsOf(warehouseKey(1)).map((event) => event.kind)).toEqual(['created', 'quarantined', 'review', 'quarantined']);
  });

  it('moves the canonical by a labels-only refresh and leaves every fact read through it unchanged (the write of §5.3 row 6)', () => {
    load(db, [onlineOrder(1, { lines: [onlineLine(1, 0, 5_000), onlineLine(1, 1, 700, { shipments: [] })] })]);
    const before = receiptOf(orderKey(1));
    const facts = (versionRef: string) => ({
      receipt: db.prepare(`SELECT date, local_time, sign, status, currency, subtotal_minor, tax_minor, instant_savings_minor, discount_minor,
        shipping_minor, fees_minor, stored_value_minor, total_minor FROM retail_receipt_versions WHERE version_ref = ?`).get(versionRef),
      lines: db.prepare(`SELECT line_ref, ordinal, kind, item_number, title, quantity, unit_price_minor, amount_minor, shipping_minor
        FROM retail_line_facts WHERE version_ref = ? ORDER BY ordinal`).all(versionRef),
      shipments: db.prepare('SELECT shipment_ref, line_ref, shipped_date, delivered_date FROM retail_shipment_facts WHERE version_ref = ? ORDER BY shipment_ref')
        .all(versionRef),
      tenders: db.prepare('SELECT tender_ref, kind, last4, amount_minor FROM retail_tender_facts WHERE version_ref = ? ORDER BY tender_ref').all(versionRef),
    });
    const seeded = seedLaterSighting(db, membershipRef('costco'), onlineOrder(1, { lines: [onlineLine(1, 0, 5_000), onlineLine(1, 1, 700,
      { shipments: [] })] }), LATER_LABELS, 'provenance-refresh');
    const after = receiptOf(orderKey(1));
    expect(after).toMatchObject({ state: 'active', canonical: seeded.versionRef, seq: before.seq + 1 });
    expect(after.canonical).not.toBe(before.canonical);
    expect(facts(after.canonical)).toEqual(facts(before.canonical));
    expect(eventsOf(orderKey(1)).map((event) => event.kind)).toEqual(['created', 'provenance-refresh']);
  });

  it('compares money directly: a stored version whose facts and digests disagree is held, by a total, a line or a tender', () => {
    const tampers: Array<[string, string]> = [
      ['retail_receipt_versions', 'UPDATE retail_receipt_versions SET tax_minor = tax_minor + 1'],
      ['retail_line_facts', 'UPDATE retail_line_facts SET amount_minor = amount_minor + 1'],
      ['retail_tender_facts', 'UPDATE retail_tender_facts SET amount_minor = amount_minor + 1'],
    ];
    for (const [table, sql] of tampers) {
      db.close();
      db = retailTestDb();
      load(db, [warehouseReceipt(1)]);
      tamper(table, sql);
      const versions = rows(db, 'SELECT count(*) FROM retail_receipt_versions');
      expect(outcomeOf(load(db, [warehouseReceipt(1)])), table).toBe('changed:1');
      expect(receiptOf(warehouseKey(1)).state, table).toBe('quarantined');
      // Equal digests: the sighting is of the stored version itself, which no fact of it changes.
      expect(rows(db, 'SELECT count(*) FROM retail_receipt_versions'), table).toBe(versions);
    }
  });
});

describe('retail import: memberships and their identity evidence (§5.4, Q-M2, D-R3-3)', () => {
  it('records each stated fact, compares identity facts with every accepted one, and never compares the tier', () => {
    load(db, [warehouseReceipt(1)], { memberSinceYear: null, membershipLast4: null });
    load(db, [warehouseReceipt(2)], {});
    load(db, [warehouseReceipt(3)], {});
    load(db, [warehouseReceipt(4)], { memberSinceYear: null, membershipLast4: null, tier: 'Gold Star' });
    expect(rows(db, 'SELECT count(*) FROM retail_memberships')).toBe(1);
    expect(db.prepare(`SELECT field, count(*) AS n FROM retail_membership_facts GROUP BY field ORDER BY field`).all()).toEqual([
      { field: 'member-since-year', n: 2 }, { field: 'membership-last4', n: 2 }, { field: 'tier', n: 4 }]);
    const imports = rows(db, 'SELECT count(*) FROM retail_imports');
    for (const [patch, field] of [[{ memberSinceYear: '2004' }, 'member-since-year'], [{ membershipLast4: '0011' }, 'membership-last4']] as const) {
      const payload = payloadOf([warehouseReceipt(5)], patch);
      expect(refusalOf(() => importPayload(db, payload))).toMatchObject({ code: 'retail-membership-conflict', details: { field } });
    }
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(imports);
  });

  it('registers two folders that share partial identity facts, and counts them as one possible overlap only', () => {
    load(db, [warehouseReceipt(1)]);
    const payload = payloadOf([warehouseReceipt(2)], { folder: 'costco-3' });
    const declared = declaration('costco-3');
    expect(planRetailImport(db, { payload, declaration: declared, membership: null }).possibleOverlap).toBe(1);
    importPayload(db, payload);
    expect(rows(db, 'SELECT count(*) FROM retail_memberships')).toBe(2);
    const third = payloadOf([warehouseReceipt(3)], { folder: 'costco-4', memberSinceYear: '1999' });
    expect(planRetailImport(db, { payload: third, declaration: declaration('costco-4'), membership: null }).possibleOverlap).toBe(1);
  });

  it('refuses an undeclared, twice-declared, unknown or mismatched membership before anything is written', () => {
    load(db, [warehouseReceipt(1)]);
    const fresh = payloadOf([warehouseReceipt(2)], { folder: 'costco-5' });
    const known = payloadOf([warehouseReceipt(3)]);
    const cases: Array<[string, () => unknown, string]> = [
      ['no declaration', () => planRetailImport(db, { payload: fresh, declaration: null, membership: null }), 'retail-membership-undeclared'],
      ['a declaration of a registered folder', () => planRetailImport(db, { payload: known, declaration: declaration('costco'), membership: null }),
        'retail-membership-declared-twice'],
      ['a GO naming a declaration for a registered folder', () => planRetailImport(db, { payload: known, declaration: null,
        membership: { declarationSha256: 'a'.repeat(64) } }), 'retail-membership-declared-twice'],
      ['a GO naming no membership\'s ref', () => planRetailImport(db, { payload: known, declaration: null,
        membership: { membershipRef: `rtl-mbr-${'a'.repeat(32)}` } }), 'retail-membership-unknown'],
      ['a GO naming a ref for a new folder', () => planRetailImport(db, { payload: fresh, declaration: declaration('costco-5'),
        membership: { membershipRef: membershipRef('costco') } }), 'retail-membership-unknown'],
      ['a declaration of another folder', () => planRetailImport(db, { payload: fresh, declaration: declaration('costco-6'), membership: null }),
        'retail-declaration-mismatch'],
      ['a GO naming another declaration', () => planRetailImport(db, { payload: fresh, declaration: declaration('costco-5'),
        membership: { declarationSha256: 'b'.repeat(64) } }), 'retail-input-mismatch'],
      ['a declaration of an owner Holdr doesn\'t know', () => planRetailImport(db, { payload: fresh,
        declaration: { ...declaration('costco-5'), declaration: { ...declaration('costco-5').declaration, owner: 'guest' as never } }, membership: null }),
      'retail-declaration-invalid'],
    ];
    for (const [what, run, code] of cases) expect(refusalOf(run).code, what).toBe(code);
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(1);
  });
});

describe('retail import: a receipt\'s channel is part of its identity (plan §4.2, §4.3, D-PR2-C6)', () => {
  it('refuses a stored receipt\'s key under another channel, in either arrival order, and changes no row', () => {
    const asGas = (receipt: RetailImportReceipt): RetailImportReceipt => ({ ...receipt, channel: 'gas' });
    // Every retail_ table's complete rows, each table's in one canonical order: an in-place UPDATE changes them as surely
    // as an insert does.
    const retailRows = () => Object.fromEntries((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'retail\\_%' ESCAPE '\\'
      ORDER BY name`).pluck().all() as string[]).map((table) => [table,
      (db.prepare(`SELECT * FROM "${table}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort()]));
    for (const [first, second] of [[warehouseReceipt(1), asGas(warehouseReceipt(1))], [asGas(warehouseReceipt(1)), warehouseReceipt(1)]]) {
      db.close();
      db = retailTestDb();
      const stored = payloadOf([first]);
      const incoming = payloadOf([second]);
      // Each payload is valid on its own: only the stored receipt makes the second one a conflict.
      validRetailPayload(stored);
      validRetailPayload(incoming);
      importPayload(db, stored);
      const before = retailRows();
      // The snapshot holds the stored receipt's own rows, so the comparison below can see them change.
      expect(before.retail_receipts, `${first.channel} then ${second.channel}: rows to compare`).toHaveLength(1);
      const refused = { code: 'retail-receipt-conflict', details: { field: 'channel', receiptRef: receiptOf(warehouseKey(1)).ref } };
      const request = { payload: incoming, declaration: null, membership: membershipChoice(db, incoming, null) };
      expect(refusalOf(() => planRetailImport(db, request)), `${first.channel} then ${second.channel}: plan`).toMatchObject(refused);
      expect(refusalOf(() => importPayload(db, incoming)), `${first.channel} then ${second.channel}: import`).toMatchObject(refused);
      expect(retailRows(), `${first.channel} then ${second.channel}`).toEqual(before);
      expect(db.prepare('SELECT channel FROM retail_receipts').pluck().all()).toEqual([first.channel]);
    }
  });

  it('quarantines, never refuses, a receipt that a hold under another channel names, in either order: the hold keeps its channel and stays reviewable', () => {
    // ROOT's ruling on C6's scope: the closed refusal is for two admitted receipts only. A held record keeps its own channel,
    // and its key's match quarantines (§5.5) whichever arrives first, so an owner's review can still settle it.
    const asGas = (receipt: RetailImportReceipt): RetailImportReceipt => ({ ...receipt, channel: 'gas' });
    for (const [admitted, held] of [['warehouse', 'gas'], ['gas', 'warehouse']] as const) {
      for (const receiptFirst of [true, false]) {
        const what = receiptFirst ? `a ${admitted} receipt, then a ${held} hold of its key` : `a ${held} hold, then a ${admitted} receipt of its key`;
        db.close();
        db = retailTestDb();
        const receipt = payloadOf([admitted === 'gas' ? asGas(warehouseReceipt(1)) : warehouseReceipt(1)]);
        const hold = payloadOf([warehouseReceipt(2)], { held: [heldRecord({ channel: held, naturalKey: warehouseKey(1) })] });
        // Each payload is valid on its own.
        validRetailPayload(receipt);
        validRetailPayload(hold);
        importPayload(db, receiptFirst ? receipt : hold);
        expect(outcomeOf(importPayload(db, receiptFirst ? hold : receipt)), what).toBe('new:1');
        const ref = receiptOf(warehouseKey(1)).ref;
        const heldRef = db.prepare('SELECT held_ref FROM retail_held WHERE natural_key = ?').pluck().get(warehouseKey(1)) as string;
        expect(db.prepare('SELECT channel FROM retail_receipts WHERE receipt_ref = ?').pluck().get(ref), what).toBe(admitted);
        expect(db.prepare('SELECT channel FROM retail_held WHERE held_ref = ?').pluck().get(heldRef), what).toBe(held);
        expect(receiptOf(warehouseKey(1)), what).toMatchObject({ state: 'quarantined', firstReason: 'receipt-held-later' });
        expect(eventsOf(warehouseKey(1)).slice(1), what).toEqual([{ kind: receiptFirst ? 'quarantined' : 'cause', reason: 'receipt-held-later',
          state: 'quarantined' }]);
        // Reviewable: the receipt's evidence cites the hold, and an owner's review settles it.
        const evidence = retailEvidence(db, ref);
        expect(evidence.held.map(([cited]) => cited), what).toEqual([heldRef]);
        expect(evidence.events[evidence.events.length - 1][3], what).toBe(heldRef);
        review(warehouseKey(1), receiptOf(warehouseKey(1)).canonical);
        expect(receiptOf(warehouseKey(1)).state, what).toBe('active');
      }
    }
  });
});

describe('retail import: stable refs (§4.3, Q-L1, D-R3-4)', () => {
  const refsOf = (versionRef: string) => ({
    lines: db.prepare('SELECT line_ref FROM retail_line_facts WHERE version_ref = ? ORDER BY ordinal').pluck().all(versionRef),
    shipments: db.prepare('SELECT shipment_ref FROM retail_shipment_facts WHERE version_ref = ? ORDER BY line_ref, position').pluck().all(versionRef),
    tenders: db.prepare('SELECT tender_ref FROM retail_tender_facts WHERE version_ref = ? ORDER BY ordinal').pluck().all(versionRef),
  });
  const shipmentRefsByCarrier = (versionRef: string) => db.prepare(`SELECT carrier, delivered_date AS delivered, shipment_ref AS ref
    FROM retail_shipment_facts WHERE version_ref = ? ORDER BY position`).all(versionRef) as Array<{ carrier: string; delivered: string | null; ref: string }>;
  const order = (shipments: ReturnType<typeof shipment>[], extra: Parameters<typeof onlineOrder>[1] = {}) =>
    onlineOrder(1, { lines: [onlineLine(1, 0, 5_000, { shipments }), onlineLine(1, 1, 900, { shipments: [] })], ...extra });
  const A = shipment({ carrier: 'ups' });
  const B = shipment({ carrier: 'fedex' });
  const C = shipment({ carrier: 'usps' });

  it('keeps every line, shipment and tender ref through a policy-only re-read, and never shares one between distinct lines', () => {
    load(db, [order([A, B])]);
    const first = receiptOf(orderKey(1)).canonical;
    const later = seedLaterSighting(db, membershipRef('costco'), order([A, B]), LATER_LABELS, 'none');
    expect(later.versionRef).not.toBe(first);
    expect(refsOf(later.versionRef)).toEqual(refsOf(first));
    expect(new Set(refsOf(first).lines).size).toBe(2);
    load(db, [warehouseReceipt(2, { lines: [warehouseLine(0, 100), warehouseLine(1, 100), warehouseLine(2, 100)] })]);
    expect(rows(db, `SELECT count(*) FROM retail_line_refs l JOIN retail_receipts r ON r.receipt_ref = l.receipt_ref WHERE r.natural_key = ?`,
      warehouseKey(2))).toBe(3);
  });

  it('follows each shipment observation, never its position, through a re-read and a review that chooses it', () => {
    load(db, [order([A, B])]);
    const first = receiptOf(orderKey(1)).canonical;
    const original = shipmentRefsByCarrier(first);
    expect(outcomeOf(load(db, [order([B, A])]))).toBe('changed:1');
    const reordered = db.prepare('SELECT version_ref FROM retail_receipt_versions WHERE version_ref <> ?').pluck().get(first) as string;
    review(orderKey(1), reordered);
    expect(receiptOf(orderKey(1))).toMatchObject({ state: 'active', canonical: reordered });
    const chosen = shipmentRefsByCarrier(reordered);
    expect(chosen.map((entry) => entry.carrier)).toEqual(['fedex', 'ups']);
    for (const entry of chosen) expect(entry.ref).toBe(original.find((old) => old.carrier === entry.carrier)!.ref);
    expect(refsOf(reordered).lines).toEqual(refsOf(first).lines);
    // An inserted shipment and one whose delivered date appears are new observations: new refs, the others kept.
    load(db, [order([A, C, { ...B, deliveredDate: '2031-01-14' }])]);
    const newest = db.prepare(`SELECT version_ref FROM retail_receipt_versions WHERE version_ref NOT IN (?, ?)`).pluck().get(first, reordered) as string;
    const refs = shipmentRefsByCarrier(newest);
    expect(refs[0].ref).toBe(original.find((old) => old.carrier === 'ups')!.ref);
    expect(original.map((old) => old.ref)).not.toContain(refs[1].ref);
    expect(original.map((old) => old.ref)).not.toContain(refs[2].ref);
  });

  it('keeps multiplicity: identical observations keep their refs by occurrence, shipments and tenders alike', () => {
    load(db, [order([A, A])]);
    const first = receiptOf(orderKey(1)).canonical;
    const twice = shipmentRefsByCarrier(first).map((entry) => entry.ref);
    expect(new Set(twice).size).toBe(2);
    load(db, [order([A, A, B])]);
    const more = db.prepare('SELECT version_ref FROM retail_receipt_versions WHERE version_ref <> ?').pluck().get(first) as string;
    const three = shipmentRefsByCarrier(more).map((entry) => entry.ref);
    expect(three.slice(0, 2)).toEqual(twice);
    expect(twice).not.toContain(three[2]);
    load(db, [order([A])]);
    const once = db.prepare('SELECT version_ref FROM retail_receipt_versions WHERE version_ref NOT IN (?, ?)').pluck().get(first, more) as string;
    expect(shipmentRefsByCarrier(once).map((entry) => entry.ref)).toEqual([twice[0]]);
    expect(shipmentRefsByCarrier(first).map((entry) => entry.ref)).toEqual(twice);
    // Two identical wallet Shop Card payments, re-read with a third: their two refs kept, the third new.
    load(db, [onlineOrder(2, { shopCards: [500, 500] })]);
    const cards = (versionRef: string) => db.prepare(`SELECT tender_ref FROM retail_tender_facts WHERE version_ref = ? AND kind = 'shop-card'
      ORDER BY ordinal`).pluck().all(versionRef) as string[];
    const firstCards = cards(receiptOf(orderKey(2)).canonical);
    load(db, [onlineOrder(2, { shopCards: [500, 500, 500] })]);
    const thirdCards = cards(db.prepare(`SELECT v.version_ref FROM retail_receipt_versions v JOIN retail_receipts r ON r.receipt_ref = v.receipt_ref
      WHERE r.natural_key = ? AND v.version_ref <> r.canonical_version`).pluck().get(orderKey(2)) as string);
    expect(new Set(firstCards).size).toBe(2);
    expect(thirdCards.slice(0, 2)).toEqual(firstCards);
    expect(firstCards).not.toContain(thirdCards[2]);
  });

  it('follows each tender observation through a re-read in the other order', () => {
    const tenders = (first: number, second: number) => warehouseReceipt(1, { lines: [warehouseLine(0, 1_000)], taxMinor: 80,
      tenders: [{ kind: 'card', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: first },
        { kind: 'card', network: 'mastercard', last4: SYNTHETIC_RETAIL.card2, amountMinor: second }] });
    load(db, [tenders(600, 480)]);
    const first = receiptOf(warehouseKey(1)).canonical;
    load(db, [{ ...tenders(600, 480), tenders: [...tenders(600, 480).tenders].reverse().map((tender, ordinal) => ({ ...tender, ordinal })) }]);
    const second = db.prepare('SELECT version_ref FROM retail_receipt_versions WHERE version_ref <> ?').pluck().get(first) as string;
    const byNetwork = (versionRef: string) => Object.fromEntries((db.prepare('SELECT network, tender_ref AS ref FROM retail_tender_facts WHERE version_ref = ?')
      .all(versionRef) as Array<{ network: string; ref: string }>).map((row) => [row.network, row.ref]));
    expect(byNetwork(second)).toEqual(byNetwork(first));
  });
});

describe('retail import: held evidence (§5.5, Q-H1, D-R2-3, D-R3-2)', () => {
  it('quarantines a stored receipt a hold names, and a readable version an earlier hold names at its creation', () => {
    load(db, [warehouseReceipt(1)]);
    const result = load(db, [warehouseReceipt(5)], { held: [heldRecord({ naturalKey: warehouseKey(1) }), heldRecord({ naturalKey: warehouseKey(2) }),
      heldRecord({ naturalKey: null, check: 'record-key', reason: 'unreadable', date: null })] });
    expect(result.held).toEqual({ 'no-key': 1, pending: 1, quarantining: 1 });
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'quarantined', firstReason: 'receipt-held-later' });
    expect(eventsOf(warehouseKey(1)).slice(1)).toEqual([{ kind: 'quarantined', reason: 'receipt-held-later', state: 'quarantined' }]);
    // The pending hold names receipt 2, which arrives later: quarantined at creation, with a cause per hold.
    expect(outcomeOf(load(db, [warehouseReceipt(2)]))).toBe('new:1');
    expect(receiptOf(warehouseKey(2))).toMatchObject({ state: 'quarantined', firstReason: 'receipt-held-later' });
    expect(eventsOf(warehouseKey(2))).toEqual([{ kind: 'created', reason: null, state: 'quarantined' },
      { kind: 'cause', reason: 'receipt-held-later', state: 'quarantined' }]);
    // A null-key hold names nothing: no event anywhere cites it.
    expect(rows(db, `SELECT count(*) FROM retail_receipt_events e JOIN retail_held h ON h.held_ref = e.held_ref WHERE h.natural_key IS NULL`)).toBe(0);
  });

  it('quarantines whichever arrives first, a later capture\'s hold or an earlier capture\'s readable version (3ddfcd26\'s chronology)', () => {
    // A later capture held, imported first; then an earlier capture with the readable version. No policy is read for a hold.
    load(db, [warehouseReceipt(8)], { held: [heldRecord({ naturalKey: warehouseKey(1) })], capturedAt: '2031-03-01T00:00:00Z' });
    load(db, [warehouseReceipt(1)], { capturedAt: '2031-01-01T00:00:00Z' });
    expect(receiptOf(warehouseKey(1)).state).toBe('quarantined');
    const other = retailTestDb();
    try {
      importPayload(other, payloadOf([warehouseReceipt(1)], { capturedAt: '2031-01-01T00:00:00Z' }));
      importPayload(other, payloadOf([warehouseReceipt(8)], { held: [heldRecord({ naturalKey: warehouseKey(1) })], capturedAt: '2031-03-01T00:00:00Z' }));
      expect(receiptOf(warehouseKey(1), other).state).toBe('quarantined');
    } finally {
      other.close();
    }
  });

  it('resolves only the holds a review pinned: a later hold quarantines again, and no import makes a quarantined receipt active', () => {
    load(db, [warehouseReceipt(1)]);
    load(db, [warehouseReceipt(5)], { held: [heldRecord({ naturalKey: warehouseKey(1) })] });
    expect(outcomeOf(load(db, [warehouseReceipt(1)]))).toBe('quarantined:1');
    expect(receiptOf(warehouseKey(1)).state).toBe('quarantined');
    review(warehouseKey(1), receiptOf(warehouseKey(1)).canonical);
    expect(receiptOf(warehouseKey(1)).state).toBe('active');
    expect(db.prepare('SELECT through_import_seq FROM retail_receipt_reviews').pluck().get()).toBe(3);
    load(db, [warehouseReceipt(6)], { held: [heldRecord({ naturalKey: warehouseKey(1), check: 'raw-missing', reason: 'raw-missing', date: null })] });
    expect(receiptOf(warehouseKey(1))).toMatchObject({ state: 'quarantined', firstReason: 'receipt-held-later' });
  });

  it('stales a prepared review by a held-only import, a new observation, or another review', () => {
    load(db, [warehouseReceipt(1)]);
    load(db, [warehouseReceipt(1, { date: '2031-01-12' })]);
    const pinned = () => retailEvidenceDigest(retailEvidence(db, receiptOf(warehouseKey(1)).ref));
    const changes: Array<[string, () => void]> = [
      ['a held-only import', () => { load(db, [], { held: [heldRecord({ naturalKey: warehouseKey(1) })] }); }],
      ['a new observation', () => { load(db, [warehouseReceipt(1)]); }],
      ['another review', () => { review(warehouseKey(1), null, 'd'.repeat(64)); }],
    ];
    for (const [what, change] of changes) {
      const before = pinned();
      change();
      expect(pinned(), what).not.toBe(before);
    }
  });
});

describe('retail import: the preflight refuses first what any CHECK would refuse (plan §2 rule 7)', () => {
  it('refuses each such payload with the validator\'s or the storage check\'s code, never a database error, and writes nothing', () => {
    load(db, [warehouseReceipt(1)]);
    const base = () => payloadOf([warehouseReceipt(2), onlineOrder(3, { lines: [onlineLine(3, 0, 5_000)] })],
      { held: [heldRecord({ naturalKey: warehouseKey(4) })] });
    type Change = (payload: RetailImportPayload) => void;
    const set = (change: Change) => change;
    const cases: Array<[string, Change, string]> = [
      ['converter version', set((p) => { p.converterVersion = 'holdr-retail-convert 1.4'; }), 'retail-payload-invalid'],
      ['format version', set((p) => { (p as { version: number }).version = 4; }), 'retail-payload-invalid'],
      ['policy version', set((p) => { (p as { policyVersion: number }).policyVersion = 4; }), 'retail-payload-invalid'],
      ['capture schema', set((p) => { (p.source as { schema: string }).schema = 'other@1'; }), 'retail-payload-invalid'],
      ['capture digest', set((p) => { p.source.captureDigest = `1${'a'.repeat(63)}`; }), 'retail-payload-invalid'],
      ['capture time that rolls over', set((p) => { p.source.capturedAt = '2031-02-30T04:05:06Z'; }), 'retail-payload-unstorable'],
      ['capture files', set((p) => { p.source.files = 0; }), 'retail-payload-invalid'],
      ['member-since year', set((p) => { p.membership.memberSinceYear = '1899'; }), 'retail-payload-invalid'],
      ['membership last four', set((p) => { p.membership.membershipLast4 = '00a7'; }), 'retail-payload-invalid'],
      ['tier', set((p) => { p.membership.tier = '1 Gold'; }), 'retail-payload-invalid'],
      ['coverage range', set((p) => { p.coverage.online[0].to = '2030-12-31'; }), 'retail-payload-invalid'],
      ['coverage count', set((p) => { p.coverage.warehouse[0].seen = 1_000_001; }), 'retail-payload-invalid'],
      ['natural key', set((p) => { p.receipts[0].naturalKey = `costco-receipt-${'1'.repeat(64)}`; }), 'retail-payload-invalid'],
      ['date', set((p) => { p.receipts[0].date = '2031-02-30'; }), 'retail-payload-invalid'],
      ['local time', set((p) => { p.receipts[0].localTime = '25:00'; }), 'retail-payload-invalid'],
      ['status on a warehouse receipt', set((p) => { p.receipts[0].status = 'shipped'; }), 'retail-payload-invalid'],
      ['currency', set((p) => { (p.receipts[0] as { currency: string }).currency = 'CAD'; }), 'retail-payload-invalid'],
      ['a total out of range', set((p) => { p.receipts[0].totals.taxMinor = 20_000_000_000; }), 'retail-payload-invalid'],
      ['a legend', set((p) => { p.receipts[0].taxLegends = [{ legend: 'AB', amountMinor: 1 }]; }), 'retail-payload-invalid'],
      ['item number', set((p) => { p.receipts[0].lines[0].itemNumber = '1'.repeat(13); }), 'retail-payload-invalid'],
      ['title spacing', set((p) => { p.receipts[0].lines[0].title = 'SAMPLE  WIDGET'; }), 'retail-payload-invalid'],
      ['title formula', set((p) => { p.receipts[0].lines[0].title2 = '=SUM()'; }), 'retail-payload-invalid'],
      ['title digits', set((p) => { p.receipts[0].lines[0].title = `SAMPLE ${'5'.repeat(13)}`; }), 'retail-payload-invalid'],
      ['department', set((p) => { p.receipts[0].lines[0].department = 10_000; }), 'retail-payload-invalid'],
      ['quantity', set((p) => { p.receipts[0].lines[0].quantity = 200_000; }), 'retail-payload-invalid'],
      ['tax flag', set((p) => { p.receipts[0].lines[0].taxFlag = 'y'; }), 'retail-payload-invalid'],
      ['fuel on an item line', set((p) => { p.receipts[0].lines[0].fuelGallons = '1.5'; }), 'retail-payload-invalid'],
      ['metal', set((p) => { p.receipts[0].lines[0].metal = { ...goldBar(), metal: 'XCU' as never }; }), 'retail-payload-invalid'],
      ['weight unit', set((p) => { p.receipts[0].lines[0].metal = goldBar({ statedWeight: { value: '1', unit: 'lb' as never } }); }), 'retail-payload-invalid'],
      ['pack', set((p) => { p.receipts[0].lines[0].metal = goldBar({ pack: 'pair' as never }); }), 'retail-payload-invalid'],
      ['flag beside metal', set((p) => { p.receipts[0].lines[0].metal = goldBar(); p.receipts[0].lines[0].metalUncertain = { guard: 'metal-guard-v1',
        evidence: ['bullion-word'], metal: null }; }), 'retail-payload-invalid'],
      ['flag evidence out of order', set((p) => { p.receipts[0].lines[0].metalUncertain = { guard: 'metal-guard-v1', evidence: ['purity', 'bullion-word'],
        metal: null }; }), 'retail-payload-invalid'],
      ['an event quantity', set((p) => { p.receipts[1].lines[0].events!.shipped[0].quantity = 0; }), 'retail-payload-invalid'],
      ['a carrier', set((p) => { p.receipts[1].lines[0].shipments[0].carrier = 'boat' as never; }), 'retail-payload-invalid'],
      ['a shipment date', set((p) => { p.receipts[1].lines[0].shipments[0].shippedDate = '2031-13-01'; }), 'retail-payload-invalid'],
      ['a last four on cash', set((p) => { p.receipts[0].tenders[0] = { ...p.receipts[0].tenders[0], kind: 'cash', network: 'unknown' }; }),
        'retail-payload-invalid'],
      ['a card with no last four', set((p) => { p.receipts[0].tenders[0].last4 = null; }), 'retail-payload-invalid'],
      ['a held key where none was read', set((p) => { p.held[0].check = 'record-key'; p.held[0].reason = 'unreadable'; p.held[0].date = null; }),
        'retail-payload-invalid'],
      ['a held check of another reason', set((p) => { p.held[0].reason = 'unreadable'; }), 'retail-payload-invalid'],
      ['a held date the files could not agree on', set((p) => { p.held[0].check = 'raw-missing'; p.held[0].reason = 'raw-missing'; }),
        'retail-payload-invalid'],
    ];
    const imports = rows(db, 'SELECT count(*) FROM retail_imports');
    for (const [what, change, code] of cases) {
      const payload = structuredClone(base());
      change(payload);
      expect(refusalOf(() => planRetailImport(db, { payload, declaration: null, membership: null })).code, what).toBe(code);
      expect(refusalOf(() => importPayload(db, payload)).code, what).toBe(code);
    }
    expect(rows(db, 'SELECT count(*) FROM retail_imports')).toBe(imports);
  });
});
