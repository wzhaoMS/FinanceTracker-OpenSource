import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

import { digest } from '../services/amazon/policy.js';
import { CARD_KIND_CORRECTIONS_SCHEMA_DIGEST, cardKindCorrectionsSchemaState } from '../services/cardKindCorrections.js';
import { audit } from '../services/cardSync/context.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { CardSyncStatements } from '../services/cardSyncStatements.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { CARD_GUARD_BUILD, SqliteStateRepo, registerCardGuardFunctions } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CARD_KIND_CORRECTIONS_CLI_USAGE, runCardKindCorrectionsCli } from './cardKindCorrections.js';

// Synthetic only: made-up cards, descriptions, amounts, ids and dates; a local owner made up for the test.
const NOW = new Date('2026-10-23T15:50:00.000Z');
const OWNER_ID = 'local-user-owner';
const OWNER = cardSyncActorRef(OWNER_ID);
const BASIS = "owner's standing fast-mode order, 2026-10-23";
const REASON = 'converter 1.0.2 reading';
let template: string, dir: string, file: string, stdout: string, stderr: string;

const run = (args: string[]) => runCardKindCorrectionsCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => NOW,
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const write = (name: string, value: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return p;
};
const goFields = (command: 'install' | 'apply' | 'undo', patch: Record<string, unknown> = {}) => ({
  format: 'holdr.card-kind-corrections-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command,
  goId: randomBytes(16).toString('hex'), databaseRef: digest(path.resolve(file)), schemaDigest: CARD_KIND_CORRECTIONS_SCHEMA_DIGEST,
  ...(command === 'install' ? {} : { previewDigest: '0'.repeat(64), actingOwnerRef: OWNER, operator: '6a592dcc', basis: BASIS, reason: REASON }),
  ...patch,
});
const go = (command: 'install' | 'apply' | 'undo', patch: Record<string, unknown> = {}) =>
  write(`go-${randomBytes(6).toString('hex')}.json`, goFields(command, patch));
const goIdOf = (goFile: string) => JSON.parse(fs.readFileSync(goFile, 'utf8')).goId as string;
const backup = (name: string) => path.join(dir, name);
const json = async (args: string[]) => {
  stdout = '';
  stderr = '';
  const code = await run(args);
  const answer = stdout ? JSON.parse(stdout) : null;
  return { code, answer, stderr };
};
const write3 = (command: 'install' | 'apply' | 'undo', goFile: string, backupName: string) =>
  json([command, '--db', file, '--backup', backup(backupName), '--root-go', goFile]);
const opened = <T>(fn: (db: Database.Database) => T) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
};

const draft = (over: Partial<CardImportDraftRow>): CardImportDraftRow => ({ transactionDate: '2026-03-02', postedDate: '2026-03-02',
  amountMinor: 1_000, kind: 'purchase', description: 'SAMPLE GROCER', ...over } as CardImportDraftRow);
const coverage = { start: '2026-02-01', end: '2026-04-30' };

/**
 * Cards and rows stored as earlier producers stored them, a review item, a checking debit and a local owner. Every
 * candidate the rules leave alone is here once, for each reason.
 */
function seed(): Record<string, string> {
  const repo = new SqliteStateRepo({ file, now: () => NOW });
  try {
    const db = repo.internalGetDb();
    db.prepare("INSERT INTO local_users (id, username, password_hash) VALUES (?, 'owner', 'synthetic')").run(OWNER_ID);
    const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0022', currency: 'USD' });
    const chase = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '0033', currency: 'USD' });
    const bilt = repo.createCardAccount({ issuer: 'bilt', owner: 'alex', last4: '0044', currency: 'USD' });
    const commit = (cardAccountId: string, issuer: string, rows: CardImportDraftRow[],
      by: { source: string; parserVersion: string } = { source: 'ofx', parserVersion: 'holdr-card-import@1.0.0' }) => repo.commitCardImport({
      cardAccountId, payload: buildCardImportPayload({ ...by, issuer, currency: 'USD', rows, coverage }).payload,
      decisions: {}, shown: { possibleDuplicateRows: [], pendingMatchRows: [], dismissedMatchRows: [], stalePendingIds: [] },
    });
    const utility = draft({ amountMinor: 4_210, kind: 'payment', description: 'SAMPLE UTILITY ONLINE PAYMENT', externalId: 'ref-a' });
    commit(citi.id, 'citi', [
      utility,
      // A payment returned: the current converter reads it as a payment too.
      draft({ transactionDate: '2026-03-05', amountMinor: 3_000, kind: 'payment', description: 'RETURNED PAYMENT', externalId: 'ref-b' }),
      // A charge with payment wording, but a payment of its size on the same card five days later.
      draft({ transactionDate: '2026-03-10', amountMinor: 7_000, kind: 'payment', description: 'WEB PAYMENT SAMPLE', externalId: 'ref-c' }),
      draft({ transactionDate: '2026-03-15', amountMinor: -7_000, kind: 'payment', description: 'ONLINE PAYMENT THANK YOU', externalId: 'ref-d' }),
      // A checking debit of its size that reads as a card payment two days later.
      draft({ transactionDate: '2026-03-20', amountMinor: 8_000, kind: 'payment', description: 'BILL PAYMENT SAMPLE', externalId: 'ref-e' }),
      draft({ transactionDate: '2026-03-25', amountMinor: 1_500, kind: 'purchase', description: 'SAMPLE GROCER', externalId: 'ref-f' }),
      // Stored as a payment with no payment wording at all.
      draft({ transactionDate: '2026-03-26', amountMinor: 990, kind: 'payment', description: 'SAMPLE STORE', externalId: 'ref-g' }),
    ]);
    commit(chase.id, 'chase', [
      draft({ transactionDate: '2026-04-01', amountMinor: 2_500, kind: 'payment', description: 'ONLINE PAYMENT SAMPLE STORE', externalId: 'ref-h' }),
      // A late payment fee stored as a payment: the current converter reads it as a fee, so it becomes one.
      draft({ transactionDate: '2026-04-05', amountMinor: 3_500, kind: 'payment', description: 'LATE PAYMENT FEE', externalId: 'ref-i' }),
      // Payment wording only the converter's rules know: outside the ruled wording, listed apart.
      draft({ transactionDate: '2026-04-08', amountMinor: 1_100, kind: 'payment', description: 'BILL PAY SAMPLE', externalId: 'ref-j' }),
      // A payment word beside credit wording: left alone.
      draft({ transactionDate: '2026-04-09', amountMinor: 1_200, kind: 'payment', description: 'PAYMENT CREDIT SAMPLE', externalId: 'ref-k' }),
    ]);
    // Another producer's file: its kinds are not the card import tool's reading.
    commit(chase.id, 'chase', [
      draft({ transactionDate: '2026-04-10', amountMinor: 1_300, kind: 'payment', description: 'ONLINE PAYMENT SAMPLE SHOP', externalId: 'ref-l' }),
    ], { source: 'ofx', parserVersion: 'synthetic-importer@1' });
    // bilt-csv's own layout sets the kind of its account rows: a positive account-level payment stays one.
    commit(bilt.id, 'bilt', [
      draft({ transactionDate: '2026-04-12', amountMinor: 1_400, kind: 'payment', description: 'PAYMENT SAMPLE', externalId: 'ref-m' }),
    ], { source: 'bilt-csv', parserVersion: 'holdr-card-import@1.0.2' });
    // The current converter's reading of the first citi row, imported again: same reference, another kind, one review item.
    const again = commit(citi.id, 'citi', [{ ...utility, kind: 'purchase' }]);
    expect(again).toMatchObject({ reviewCount: 1 });
    installCheckingSchema(db);
    importCheckingPayload(db, {
      format: 'holdr.checking-import', version: 1, parserVersion: 'synthetic@1',
      account: { institution: 'wellsfargo', type: 'checking', last4: '0001', label: 'Synthetic checking', currency: 'USD' },
      segments: [{ source: 'ofx', coverage: { start: '2026-03-01', end: '2026-04-30' }, anchors: [], rows: [
        { postedDate: '2026-03-03', amountMinor: -4_210, description: 'TRANSFER TO SAMPLE SAVINGS', checkNumber: null, bankType: 'DEBIT', externalIdHash: null },
        { postedDate: '2026-03-22', amountMinor: -8_000, description: 'CITI AUTOPAY PAYMENT SAMPLE HOLDER', checkNumber: null, bankType: 'DEBIT', externalIdHash: null },
      ] }],
    }, { now: NOW.toISOString(), goId: 'c'.repeat(32), purpose: 'copy-rehearsal' });
    const id = (description: string) => db.prepare('SELECT id FROM card_transactions WHERE description = ?').pluck().get(description) as string;
    return { utility: id('SAMPLE UTILITY ONLINE PAYMENT'), chase: id('ONLINE PAYMENT SAMPLE STORE'), lateFee: id('LATE PAYMENT FEE'),
      returned: id('RETURNED PAYMENT') };
  } finally {
    repo.close();
  }
}

beforeAll(async () => {
  template = await makeScratchDir('card-kind-corrections-template-');
  const templateFile = path.join(template, 'finance.db');
  new SqliteStateRepo({ file: templateFile }).close();
  const db = new Database(templateFile);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
});
afterAll(async () => { await removeScratchDir(template); });
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = await makeScratchDir('card-kind-corrections-cli-');
  file = path.join(dir, 'finance.db');
  fs.copyFileSync(path.join(template, 'finance.db'), file);
});
afterEach(async () => { await removeScratchDir(dir); });

const PLAN_ROWS = { 'chase:0033': ['2026-04-01', '2026-04-05'], 'citi:0022': ['2026-03-02'] };

describe('holdr-card-kinds', () => {
  it('prints its usage', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(CARD_KIND_CORRECTIONS_CLI_USAGE);
  });

  it('plans read-only: the rows the rules correct, the candidates they leave alone and why, value-free', async () => {
    seed();
    const before = fs.readFileSync(file);
    const { code, answer } = await json(['plan', '--db', file]);
    expect(code).toBe(0);
    expect(answer).toMatchObject({
      code: 'card-kind-corrections-planned', schema: 'absent', schemaDigest: CARD_KIND_CORRECTIONS_SCHEMA_DIGEST,
      databaseRef: digest(path.resolve(file)), checkingInstalled: true, rows: 3, byCard: PLAN_ROWS, fromKinds: { payment: 3 },
      toKinds: { fee: 1, purchase: 2 }, parserVersions: { 'holdr-card-import@1.0.0': 3 },
      excluded: 8, excludedByReason: { 'card-payment-debit-within-15-days': 1, 'converter-reads-payment': 1, 'export-sets-kind': 1,
        'no-payment-wording': 1, 'not-from-the-converter': 1, 'other-payment-wording': 1, 'return-or-credit-wording': 1,
        'same-card-payment-within-30-days': 1 },
      reviewItems: 1, corrections: null,
    });
    expect(answer.excludedRows).toEqual(expect.arrayContaining([
      { card: 'bilt:0044', date: '2026-04-12', reason: 'export-sets-kind' },
      { card: 'chase:0033', date: '2026-04-10', reason: 'not-from-the-converter' },
      { card: 'chase:0033', date: '2026-04-08', reason: 'other-payment-wording' },
    ]));
    expect(answer.spendingRows.after - answer.spendingRows.before).toBe(3);
    expect(answer.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    // Value-free: no description, no amount.
    expect(stdout).not.toMatch(/SAMPLE|PAYMENT|4210|42\.10|7000|8000/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('installs, applies exactly the plan the GO names with honest provenance, replays to nothing, and undoes', async () => {
    const ids = seed();
    // Install, then its replay: the exact command again, with its backup there now, changes nothing; so does another GO.
    const installGo = go('install');
    expect((await write3('install', installGo, 'before-install.db')).answer).toMatchObject({ code: 'card-kind-corrections-installed' });
    expect(opened(cardKindCorrectionsSchemaState)).toBe('present');
    const installBackup = fs.readFileSync(backup('before-install.db'));
    expect(await write3('install', installGo, 'before-install.db')).toMatchObject({ code: 0,
      answer: { code: 'card-kind-corrections-already-installed', changes: 0 } });
    expect(fs.readFileSync(backup('before-install.db')).equals(installBackup)).toBe(true);
    expect((await write3('install', go('install'), 'never.db')).answer).toMatchObject({ code: 'card-kind-corrections-already-installed' });
    expect(fs.existsSync(backup('never.db'))).toBe(false);

    const { answer: planned } = await json(['plan', '--db', file]);
    expect(planned).toMatchObject({ schema: 'present', rows: 3, corrections: { inForce: 0, undone: 0, revertedByOwner: 0 } });
    // A GO that names another plan, or an owner who is not this Holdr's, is refused before any backup.
    expect((await write3('apply', go('apply'), 'refused-1.db')).stderr).toMatch(/input-refused HoldrRefusal \(the rows the rules choose/);
    expect((await write3('apply', go('apply', { previewDigest: planned.previewDigest, actingOwnerRef: `usr_${'p'.repeat(32)}` }),
      'refused-2.db')).stderr).toMatch(/input-refused HoldrRefusal \(actingOwnerRef names no local owner/);
    expect(fs.existsSync(backup('refused-1.db')) || fs.existsSync(backup('refused-2.db'))).toBe(false);

    const applyGo = go('apply', { previewDigest: planned.previewDigest, purpose: 'production-apply' });
    const applyId = goIdOf(applyGo);
    const applied = await write3('apply', applyGo, 'before-apply.db');
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.answer).toMatchObject({ code: 'card-kind-corrections-applied', goId: applyId, purpose: 'production-apply', rows: 3,
      byCard: PLAN_ROWS, reviewItemsSuperseded: 1 });
    expect(applied.answer.spendingRows.after - applied.answer.spendingRows.before).toBe(3);
    expect(fs.existsSync(backup('before-apply.db'))).toBe(true);
    expect(stdout).not.toMatch(/SAMPLE|PAYMENT|4210/);

    const newKind: Record<string, string> = { [ids.utility]: 'purchase', [ids.chase]: 'purchase', [ids.lateFee]: 'fee' };
    opened((db) => {
      expect(db.prepare('SELECT id, kind FROM card_transactions WHERE id IN (?, ?, ?, ?)').all(ids.utility, ids.chase, ids.lateFee, ids.returned))
        .toEqual(expect.arrayContaining([...Object.entries(newKind).map(([id, kind]) => ({ id, kind })), { id: ids.returned, kind: 'payment' }]));
      // The ledger event names the owner (the schema has no operator actor), as a session-origin correction no other path writes.
      const events = db.prepare(`SELECT id, card_transaction_id, event_type, origin, actor_kind, actor_ref, reason, from_kind, to_kind
        FROM card_transaction_events WHERE event_type = 'corrected' ORDER BY card_transaction_id`).all() as Array<Record<string, string>>;
      expect(events.map(({ id: _id, ...rest }) => rest)).toEqual(Object.keys(newKind).sort().map((transactionId) => ({
        card_transaction_id: transactionId, event_type: 'corrected', origin: 'session', actor_kind: 'session', actor_ref: OWNER,
        reason: 'posted-correction', from_kind: 'payment', to_kind: newKind[transactionId] })));
      // The audit row is the system's, and the correction record says who acted, on what basis and why.
      expect(db.prepare(`SELECT actor_kind, actor_ref, code, ledger_event_id FROM card_sync_audit_events
        WHERE event_type = 'ledger-maintenance' ORDER BY ledger_event_id`).all())
        .toEqual(events.map((event) => ({ actor_kind: 'system', actor_ref: null, code: 'operator-kind-correction', ledger_event_id: event.id }))
          .sort((a, b) => (a.ledger_event_id < b.ledger_event_id ? -1 : 1)));
      expect(db.prepare(`SELECT card_transaction_id, go_id, applied_by, basis, reason, acting_owner_ref, from_kind, to_kind, undone_at
        FROM card_kind_corrections ORDER BY card_transaction_id`).all()).toEqual(Object.keys(newKind).sort().map((transactionId) => ({
        card_transaction_id: transactionId, go_id: applyId, applied_by: `operator 6a592dcc under ROOT GO ${applyId}`, basis: BASIS,
        reason: REASON, acting_owner_ref: OWNER, from_kind: 'payment', to_kind: newKind[transactionId], undone_at: null })));
      // The review item that asked about the first row is closed by the system refresh.
      expect(db.prepare("SELECT status FROM card_reconciliation_suggestions").pluck().all()).toEqual(['superseded']);
      // The GO is recorded once, with the digest of its whole artifact and its authority.
      expect(db.prepare(`SELECT go_id, command, purpose, go_digest, preview_digest, applied_go_id, acting_owner_ref, applied_by, basis,
          reason, row_count FROM card_kind_correction_gos`).all()).toEqual([{ go_id: applyId, command: 'apply', purpose: 'production-apply',
        go_digest: digest(JSON.parse(fs.readFileSync(applyGo, 'utf8'))), preview_digest: planned.previewDigest, applied_go_id: null,
        acting_owner_ref: OWNER, applied_by: `operator 6a592dcc under ROOT GO ${applyId}`, basis: BASIS, reason: REASON, row_count: 3 }]);
    });

    // A replay changes nothing and takes no backup: the exact command again (its backup there now), or with another path.
    const applyBackup = fs.readFileSync(backup('before-apply.db'));
    const again = await write3('apply', applyGo, 'before-apply.db');
    expect(again).toMatchObject({ code: 0, answer: { code: 'card-kind-corrections-already-applied', rows: 3, changes: 0 } });
    expect(fs.readFileSync(backup('before-apply.db')).equals(applyBackup)).toBe(true);
    const replay = await write3('apply', applyGo, 'replay.db');
    expect(replay.answer).toMatchObject({ code: 'card-kind-corrections-already-applied', rows: 3, changes: 0 });
    expect(fs.existsSync(backup('replay.db'))).toBe(false);
    const { answer: empty } = await json(['plan', '--db', file]);
    expect(empty).toMatchObject({ rows: 0, corrections: { inForce: 3, undone: 0, revertedByOwner: 0 } });
    // Another artifact under the recorded goId is refused, and so is a GO for a plan with no row, both before any backup.
    const altered = write('altered-go.json', { ...JSON.parse(fs.readFileSync(applyGo, 'utf8')), reason: 'another reason entirely' });
    expect((await write3('apply', altered, 'altered.db')).stderr)
      .toMatch(/input-refused HoldrRefusal \(a GO with that goId is already recorded with other contents/);
    expect((await write3('apply', go('apply', { previewDigest: empty.previewDigest }), 'empty.db')).stderr)
      .toMatch(/input-refused HoldrRefusal \(the plan corrects no row/);
    expect(fs.existsSync(backup('altered.db')) || fs.existsSync(backup('empty.db'))).toBe(false);

    // The records are append-only: a correction record changes only by being undone, nothing is deleted or replaced, and a GO
    // record never changes.
    const writable = new Database(file);
    try {
      const refused: Array<[string, RegExp]> = [
        ["UPDATE card_kind_corrections SET from_kind = 'fee'", /changes only by being undone/],
        ['DELETE FROM card_kind_corrections', /card kind corrections are never deleted/],
        ['INSERT OR REPLACE INTO card_kind_corrections SELECT * FROM card_kind_corrections LIMIT 1', /never replaced/],
        ["UPDATE card_kind_correction_gos SET reason = 'another reason entirely'", /card kind correction GOs never change/],
        ['DELETE FROM card_kind_correction_gos', /card kind correction GOs are never deleted/],
      ];
      for (const [sql, message] of refused) expect(() => writable.exec(sql), sql).toThrow(message);
      // Each correction record is bound 1:1 to its system audit row: a record whose event has no such row is refused, and
      // so is an undo without its own -undo audit row.
      const created = (id: string) => writable.prepare("SELECT id FROM card_transaction_events WHERE card_transaction_id = ? AND event_type = 'created'")
        .pluck().get(id) as string;
      const accountOf = (id: string) => writable.prepare('SELECT card_account_id FROM card_transactions WHERE id = ?').pluck().get(id) as string;
      expect(() => writable.prepare(`INSERT INTO card_kind_corrections (id, go_id, preview_digest, card_transaction_id, card_account_id,
          from_kind, to_kind, revision_before, revision_after, ledger_event_id, acting_owner_ref, applied_by, basis, reason, created_at)
        VALUES (?, ?, ?, ?, ?, 'payment', 'purchase', 1, 2, ?, ?, ?, ?, ?, ?)`).run(`kcr_${'a'.repeat(32)}`, 'c'.repeat(32), 'd'.repeat(64),
        ids.returned, accountOf(ids.returned), created(ids.returned), OWNER, 'operator 6a592dcc under ROOT GO c', BASIS, REASON, NOW.toISOString()))
        .toThrow(/a card kind correction has exactly one system audit row of its own/);
      expect(() => writable.prepare(`UPDATE card_kind_corrections SET undone_at = ?, undo_go_id = ?, undo_event_id = ?, undone_by = ?
          WHERE card_transaction_id = ?`).run(NOW.toISOString(), 'e'.repeat(32), created(ids.utility), 'operator 6a592dcc under ROOT GO e',
        ids.utility)).toThrow(/a card kind correction is undone with exactly one system undo audit row of its own/);
    } finally {
      writable.close();
    }
    opened((db) => {
      // One system audit row per correction record, and each record's own; no orphan.
      expect(db.prepare(`SELECT count(*) FROM card_sync_audit_events a JOIN card_kind_corrections k ON k.ledger_event_id = a.ledger_event_id
        WHERE a.code = 'operator-kind-correction' AND a.actor_kind = 'system'`).pluck().get()).toBe(3);
      expect(db.prepare("SELECT count(*) FROM card_sync_audit_events WHERE code = 'operator-kind-correction'").pluck().get()).toBe(3);
    });
    expect((await json(['plan', '--db', file])).answer).toMatchObject({ unboundAuditRows: 0 });

    // The owner's own Revert in the charge's history undoes one correction.
    const repo = new SqliteStateRepo({ file, now: () => NOW });
    try {
      const sources = repo.getCardTransactionSources({ transactionId: ids.chase, continue: null, limits: { events: 10, identities: 10, merged: 10 } })!;
      expect(sources.revertibleEventId).toMatch(/^card-event-/);
      repo.revertCardTransactionChange({ transactionId: ids.chase, eventId: sources.revertibleEventId!,
        expectedRevision: sources.transaction.revision, actorRef: OWNER });
    } finally {
      repo.close();
    }
    expect((await json(['plan', '--db', file])).answer).toMatchObject({ corrections: { inForce: 2, undone: 0, revertedByOwner: 1 } });

    // A record changed behind the triggers' back: without the trigger the tables are in conflict, and with it put back the
    // record no longer matches its append-only ledger event; plan, undo-plan and undo refuse, before any backup.
    const triggerSql = opened((db) => db.prepare("SELECT sql FROM sqlite_master WHERE name = 'card_kind_corrections_update'").pluck()
      .get() as string);
    const tamper = (fromKind: string) => {
      const raw = new Database(file);
      try {
        raw.exec('DROP TRIGGER card_kind_corrections_update');
        raw.prepare('UPDATE card_kind_corrections SET from_kind = ? WHERE card_transaction_id = ?').run(fromKind, ids.utility);
      } finally {
        raw.close();
      }
    };
    const putBack = () => {
      const raw = new Database(file);
      try { raw.exec(triggerSql); } finally { raw.close(); }
    };
    tamper('fee');
    expect(await json(['plan', '--db', file])).toMatchObject({ code: 1, answer: { schema: 'conflict' } });
    putBack();
    const mismatch = await json(['undo-plan', '--db', file, '--applied-go', applyId]);
    expect(mismatch).toMatchObject({ code: 1, answer: { schema: 'present', rows: 1,
      skippedByReason: { 'record-mismatch': 1, 'reverted-by-owner': 1 } } });
    expect((await write3('undo', go('undo', { appliedGoId: applyId, previewDigest: mismatch.answer.previewDigest }), 'mismatch.db')).stderr)
      .toMatch(/input-refused HoldrRefusal \(a correction record does not match its ledger event/);
    expect(fs.existsSync(backup('mismatch.db'))).toBe(false);
    tamper('payment');
    putBack();

    // The command's undo sets back what is still in force, leaves the owner's revert alone, and replays to nothing.
    const undoPlan = await json(['undo-plan', '--db', file, '--applied-go', applyId]);
    expect(undoPlan.answer).toMatchObject({ code: 'card-kind-corrections-undo-planned', rows: 2,
      byCard: { 'chase:0033': ['2026-04-05'], 'citi:0022': ['2026-03-02'] }, fromKinds: { fee: 1, purchase: 1 }, toKinds: { payment: 2 },
      skipped: 1, skippedByReason: { 'reverted-by-owner': 1 } });
    const undoGo = go('undo', { appliedGoId: applyId, previewDigest: undoPlan.answer.previewDigest, reason: 'undo on the operator order' });
    const undone = await write3('undo', undoGo, 'before-undo.db');
    expect(undone.answer).toMatchObject({ code: 'card-kind-corrections-undone', appliedGoId: applyId, rows: 2 });
    expect(undone.answer.spendingRows.before - undone.answer.spendingRows.after).toBe(2);
    opened((db) => {
      expect(db.prepare('SELECT kind FROM card_transactions WHERE id IN (?, ?)').pluck().all(ids.utility, ids.lateFee)).toEqual(['payment', 'payment']);
      expect(db.prepare('SELECT undo_go_id, undone_by FROM card_kind_corrections WHERE card_transaction_id = ?').get(ids.utility))
        .toEqual({ undo_go_id: goIdOf(undoGo), undone_by: `operator 6a592dcc under ROOT GO ${goIdOf(undoGo)}` });
      expect(db.prepare("SELECT count(*) FROM card_sync_audit_events WHERE code = 'operator-kind-correction-undo' AND actor_kind = 'system'")
        .pluck().get()).toBe(2);
      // The undo GO is recorded with its own basis and reason.
      expect(db.prepare('SELECT command, purpose, applied_go_id, basis, reason, row_count FROM card_kind_correction_gos WHERE go_id = ?')
        .get(goIdOf(undoGo))).toEqual({ command: 'undo', purpose: 'copy-rehearsal', applied_go_id: applyId, basis: BASIS,
        reason: 'undo on the operator order', row_count: 2 });
    });
    const raw = new Database(file);
    try {
      expect(() => raw.prepare('UPDATE card_kind_corrections SET undone_by = ? WHERE card_transaction_id = ?')
        .run('operator another under ROOT GO again', ids.utility)).toThrow(/an undone card kind correction never changes/);
    } finally {
      raw.close();
    }
    const undoBackup = fs.readFileSync(backup('before-undo.db'));
    expect(await write3('undo', undoGo, 'before-undo.db')).toMatchObject({ code: 0,
      answer: { code: 'card-kind-corrections-already-undone', changes: 0 } });
    expect(fs.readFileSync(backup('before-undo.db')).equals(undoBackup)).toBe(true);
    expect((await write3('undo', undoGo, 'undo-replay.db')).answer).toMatchObject({ code: 'card-kind-corrections-already-undone', changes: 0 });
    expect(fs.existsSync(backup('undo-replay.db'))).toBe(false);
  });

  it('refuses a GO that is not exactly right and a relative path before opening the database, and a backup that exists before any write', async () => {
    seed();
    expect((await write3('install', go('install'), 'installed.db')).code).toBe(0);
    const { answer: planned } = await json(['plan', '--db', file]);
    const good = { previewDigest: planned.previewDigest };
    const refusals: Array<Record<string, unknown>> = [
      { format: 'holdr.checking-go' }, { version: 2 }, { authority: 'Alex' }, { decision: 'NO' }, { purpose: 'production-install' },
      { command: 'undo' }, { goId: 'G'.repeat(32) }, { databaseRef: '0'.repeat(64) }, { schemaDigest: '0'.repeat(64) },
      { previewDigest: 'x' }, { actingOwnerRef: 'usr_1234' }, { operator: 'A' }, { basis: 'card 1234567890123' }, { reason: '' },
      { extra: true },
    ];
    for (const patch of refusals) {
      const result = await write3('apply', go('apply', { ...good, ...patch }), 'x.db');
      expect([result.code, result.stderr], JSON.stringify(patch)).toEqual([1, 'card-kind-corrections: input-refused HoldrRefusal\n']);
    }
    expect(fs.existsSync(backup('x.db'))).toBe(false);
    expect((await json(['apply', '--db', 'finance.db', '--backup', backup('y.db'), '--root-go', go('apply', good)])).code).toBe(1);
    fs.writeFileSync(backup('exists.db'), '');
    expect((await write3('apply', go('apply', good), 'exists.db')).stderr).toBe('card-kind-corrections: input-refused HoldrRefusal\n');
    expect(opened((db) => db.prepare('SELECT count(*) FROM card_kind_corrections').pluck().get())).toBe(0);
  });

  /** Seeds, installs and applies the plan; the GO id it applied. */
  const installAndApply = async () => {
    const ids = seed();
    expect((await write3('install', go('install'), 'installed.db')).code).toBe(0);
    const { answer: planned } = await json(['plan', '--db', file]);
    const applyGo = go('apply', { previewDigest: planned.previewDigest });
    expect((await write3('apply', applyGo, 'applied.db')).code).toBe(0);
    return { ids, applyId: goIdOf(applyGo) };
  };
  const UNBOUND = 'card-kind-corrections: input-refused HoldrRefusal (an operator kind-correction audit row is not bound to exactly one'
    + ' correction record; nothing was written)\n';
  /** plan shows the unbound rows; apply and undo refuse before any backup; no GO seals over them. */
  const expectRefusedWhileUnbound = async (applyId: string, unbound: number) => {
    const { answer: planned } = await json(['plan', '--db', file]);
    expect(planned.unboundAuditRows).toBe(unbound);
    const apply = await write3('apply', go('apply', { previewDigest: planned.previewDigest }), 'refused-apply.db');
    const undoPlan = await json(['undo-plan', '--db', file, '--applied-go', applyId]);
    const undo = await write3('undo', go('undo', { appliedGoId: applyId, previewDigest: undoPlan.answer.previewDigest }), 'refused-undo.db');
    expect([apply.code, apply.stderr, undo.code, undo.stderr]).toEqual([1, UNBOUND, 1, UNBOUND]);
    expect(fs.existsSync(backup('refused-apply.db')) || fs.existsSync(backup('refused-undo.db'))).toBe(false);
    const raw = new Database(file);
    try {
      expect(() => raw.prepare(`INSERT INTO card_kind_correction_gos (go_id, command, purpose, go_digest, preview_digest, applied_go_id,
          acting_owner_ref, applied_by, basis, reason, row_count, created_at) VALUES (?, 'apply', 'copy-rehearsal', ?, ?, NULL, ?, ?, ?, ?, 1, ?)`)
        .run('d'.repeat(32), 'e'.repeat(64), 'f'.repeat(64), OWNER, 'operator 6a592dcc under ROOT GO d', BASIS, REASON, NOW.toISOString()))
        .toThrow(/every operator kind-correction audit row is bound to exactly one correction record/);
    } finally {
      raw.close();
    }
    return undoPlan;
  };

  it('refuses a duplicate operator audit row of a correction (exactly one, not at least one), written with the card guards', async () => {
    const { applyId } = await installAndApply();
    const raw = new Database(file);
    try {
      registerCardGuardFunctions(raw);
      raw.prepare(`INSERT INTO card_sync_audit_events (id, event_type, actor_kind, actor_ref, card_account_id, binding_id, device_id,
          pairing_id, run_id, observation_set_id, plan_id, ledger_event_id, code, version_before, version_after, row_count, byte_count,
          item_count, authorization_generation, created_at)
        SELECT ?, event_type, actor_kind, actor_ref, card_account_id, binding_id, device_id, pairing_id, run_id, observation_set_id, plan_id,
          ledger_event_id, code, version_before, version_after, row_count, byte_count, item_count, authorization_generation, created_at
        FROM card_sync_audit_events WHERE code = 'operator-kind-correction' ORDER BY rowid LIMIT 1`).run(`card-audit-${'p'.repeat(32)}`);
      expect(raw.prepare("SELECT count(*) FROM card_sync_audit_events WHERE code = 'operator-kind-correction'").pluck().get()).toBe(4);
    } finally {
      raw.close();
    }
    // Both rows naming that correction's event are unbound now, and the undo plan no longer trusts its record.
    const undoPlan = await expectRefusedWhileUnbound(applyId, 2);
    expect(undoPlan).toMatchObject({ code: 1, answer: { skippedByReason: { 'record-mismatch': 1 } } });
  });

  it("refuses an orphan operator audit row naming the owner's Revert, written with the card guards", async () => {
    const { ids, applyId } = await installAndApply();
    const repo = new SqliteStateRepo({ file, now: () => NOW });
    try {
      const sources = repo.getCardTransactionSources({ transactionId: ids.chase, continue: null, limits: { events: 10, identities: 10, merged: 10 } })!;
      repo.revertCardTransactionChange({ transactionId: ids.chase, eventId: sources.revertibleEventId!,
        expectedRevision: sources.transaction.revision, actorRef: OWNER });
    } finally {
      repo.close();
    }
    const raw = new Database(file);
    try {
      registerCardGuardFunctions(raw);
      const revert = raw.prepare("SELECT id, card_account_id FROM card_transaction_events WHERE card_transaction_id = ? AND event_type = 'reversed'")
        .get(ids.chase) as { id: string; card_account_id: string };
      audit({ db: raw, now: NOW.toISOString(), statements: new CardSyncStatements(raw), guardRevision: CARD_GUARD_BUILD.revision },
        'ledger-maintenance', { kind: 'system' }, { cardAccountId: revert.card_account_id, code: 'operator-kind-correction',
          ledgerEventId: revert.id, versionBefore: 2, versionAfter: 3 });
    } finally {
      raw.close();
    }
    const undoPlan = await expectRefusedWhileUnbound(applyId, 1);
    expect(undoPlan.answer).toMatchObject({ rows: 2, skippedByReason: { 'reverted-by-owner': 1 } });
  });

  it("shows a custom issuer's slug without its digits in the plan, the receipt and the undo plan", async () => {
    seed();
    const repo = new SqliteStateRepo({ file, now: () => NOW });
    try {
      const custom = repo.createCardAccount({ issuer: 'samplebank12345678', owner: 'alex', last4: '0099', currency: 'USD' });
      repo.commitCardImport({
        cardAccountId: custom.id, payload: buildCardImportPayload({ source: 'ofx', parserVersion: 'holdr-card-import@1.0.0',
          issuer: 'samplebank12345678', currency: 'USD', coverage, rows: [draft({ transactionDate: '2026-04-20', amountMinor: 1_600,
            kind: 'payment', description: 'ONLINE PAYMENT SAMPLE CLUB', externalId: 'ref-n' })] }).payload,
        decisions: {}, shown: { possibleDuplicateRows: [], pendingMatchRows: [], dismissedMatchRows: [], stalePendingIds: [] },
      });
    } finally {
      repo.close();
    }
    const outputs: string[] = [];
    const { answer: planned } = await json(['plan', '--db', file]);
    outputs.push(stdout);
    expect(planned).toMatchObject({ rows: 4, byCard: { ...PLAN_ROWS, 'samplebank:0099': ['2026-04-20'] } });
    expect((await write3('install', go('install'), 'installed.db')).code).toBe(0);
    const applyGo = go('apply', { previewDigest: planned.previewDigest });
    const applied = await write3('apply', applyGo, 'applied.db');
    outputs.push(stdout);
    expect(applied.answer).toMatchObject({ code: 'card-kind-corrections-applied', rows: 4 });
    expect(applied.answer.byCard['samplebank:0099']).toEqual(['2026-04-20']);
    const undoPlan = await json(['undo-plan', '--db', file, '--applied-go', goIdOf(applyGo)]);
    outputs.push(stdout);
    expect(undoPlan.answer.byCard['samplebank:0099']).toEqual(['2026-04-20']);
    for (const output of outputs) expect(output).not.toMatch(/12345678|samplebank1/);
  });
});
