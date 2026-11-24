import type { Database } from 'better-sqlite3';
import {
  CARD_IMPORT_KINDS,
  cardSpendingRole,
  classifyCardKind,
  classifyCheckingDebit,
  hasCardPaymentWord,
  type CardTransactionKind,
} from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import { materialChange } from './cardLedger/classify.js';
import { CardLedgerWriter } from './cardLedger/writer.js';
import { audit, type CardSyncContext } from './cardSync/context.js';
import { refreshCardReviewItems } from './cardSync/review.js';
import { cardSyncActorRef, randomCardSyncLetters } from './cardSyncDigests.js';
import { CardSyncStatements } from './cardSyncStatements.js';
import { HoldrRefusal, toValueFreeDbError } from './dbErrors.js';

/**
 * Operator kind corrections (Root ruling 2026-10-23, flag 2): posted rows the card import tool stored as card payments
 * although they are charges, a payment word in a bill paid with the card, set to the kind the tool reads now
 * (`classifyCardKind`, card import tool 1.0.2 and later). Run only by the Root-GO-gated operator command
 * (cli/cardKindCorrections.ts), never by the API.
 *
 * Each correction is one reversible ledger change through the ledger writer: a `corrected` event whose reversal marker
 * is the row's previous revision, so the owner's own Revert in a charge's history undoes it, as does the command's
 * `undo`. The card-sync schema has no operator actor: a session event must name an owner (`usr_`), so the event names
 * the owner on whose standing order the operator acted, with origin `session`, which no other path writes for a
 * `corrected` event; the UI reads that shape as a maintenance correction, never as the owner's own edit. Everything
 * else says what happened: the `ledger-maintenance` audit row is the system's, and its fixed code
 * (`operator-kind-correction`, `-undo` for an undo) is its own statement that an operator made the change. The audit
 * table is guarded card schema whose only free text is a lowercase code, so it cannot carry who applied a GO, the
 * basis or the reason (Root ruling 16:56Z): triggers bind each such row 1:1 to the correction record that does. This
 * module's two tables keep the rest. `card_kind_correction_gos` keeps every GO that wrote: the digest of its whole
 * artifact, its purpose and plan, the acting owner, who applied it, basis and reason. `card_kind_corrections` keeps
 * every row a GO corrected: old and new kind, revisions, the ledger event, who applied it, basis, reason, and when and
 * by which GO it was undone. Triggers keep both append-only and bound (see TRIGGER_SQL), and every record must match
 * its ledger event, which is append-only too. Nothing creates the tables at boot: only the backed-up, Root-GO-gated
 * `install` does, as for the payment decisions.
 *
 * A row is corrected only when all of these hold, checked again inside the write:
 * - it is posted, stored as `payment`, and adds to the balance (a charge);
 * - the card import tool stored it (its import batch's parser is `holdr-card-import@…`), from a format whose kinds
 *   come from the tool's rules: not bilt-csv, whose own layout sets the kind of its account rows;
 * - the tool now reads it as anything but a payment: a purchase, or a fee, interest or `other` where its wording says
 *   so. It takes that kind;
 * - its text has payment wording as the value-free reconciliation check read it: PAYMENT, PMT or PYMT, and no return,
 *   reversal, adjustment, refund or credit wording;
 * - no payment of its size is on the same card within 30 days;
 * - no checking debit of its size that reads as a card payment (or a Bilt housing pull) is within 15 days.
 * The plan's digest pins every chosen row's id, revision and new kind; apply refuses unless the plan is still exactly
 * that. Output and refusals carry counts, dates, `issuer:last4` (a custom issuer slug without its digits), fixed codes
 * and digests only.
 */

const TABLE = 'card_kind_corrections';
const GOS_TABLE = 'card_kind_correction_gos';
const KINDS_SQL = CARD_IMPORT_KINDS.map((kind) => `'${kind}'`).join(', ');
const TEXT_CHECK = (column: string) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 3 AND 200`;
const INSTANT_CHECK = (column: string) =>
  `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column}`;
const HEX_CHECK = (column: string, length: number) =>
  `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = ${length} AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const ID_CHECK = (column: string, prefix: string, length: number) =>
  `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = ${length} AND substr(${column}, 1, ${prefix.length}) = '${prefix}' AND substr(${column}, ${prefix.length + 1}) NOT GLOB '*[^a-p]*'`;

const GOS_SQL = `CREATE TABLE card_kind_correction_gos (
  go_id TEXT NOT NULL PRIMARY KEY CHECK (${HEX_CHECK('go_id', 32)}),
  command TEXT NOT NULL CHECK (command IN ('apply', 'undo')),
  purpose TEXT NOT NULL CHECK (purpose IN ('copy-rehearsal', 'production-apply', 'production-undo')),
  go_digest TEXT NOT NULL CHECK (${HEX_CHECK('go_digest', 64)}),
  preview_digest TEXT NOT NULL CHECK (${HEX_CHECK('preview_digest', 64)}),
  applied_go_id TEXT CHECK (applied_go_id IS NULL OR (${HEX_CHECK('applied_go_id', 32)})),
  acting_owner_ref TEXT NOT NULL CHECK (${ID_CHECK('acting_owner_ref', 'usr_', 36)}),
  applied_by TEXT NOT NULL CHECK (${TEXT_CHECK('applied_by')}),
  basis TEXT NOT NULL CHECK (${TEXT_CHECK('basis')}),
  reason TEXT NOT NULL CHECK (${TEXT_CHECK('reason')}),
  row_count INTEGER NOT NULL CHECK (typeof(row_count) = 'integer' AND row_count BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (${INSTANT_CHECK('created_at')}),
  CHECK ((command = 'undo') = (applied_go_id IS NOT NULL) AND applied_go_id IS NOT go_id
    AND purpose IN ('copy-rehearsal', 'production-' || command))
)`;
const TABLE_SQL = `CREATE TABLE card_kind_corrections (
  id TEXT NOT NULL PRIMARY KEY CHECK (${ID_CHECK('id', 'kcr_', 36)}),
  go_id TEXT NOT NULL CHECK (${HEX_CHECK('go_id', 32)}),
  preview_digest TEXT NOT NULL CHECK (${HEX_CHECK('preview_digest', 64)}),
  card_transaction_id TEXT NOT NULL CHECK (${ID_CHECK('card_transaction_id', 'card-txn-', 41)}),
  card_account_id TEXT NOT NULL CHECK (${ID_CHECK('card_account_id', 'card-acct-', 42)}),
  from_kind TEXT NOT NULL CHECK (from_kind IN (${KINDS_SQL})),
  to_kind TEXT NOT NULL CHECK (to_kind IN (${KINDS_SQL}) AND to_kind <> from_kind),
  revision_before INTEGER NOT NULL CHECK (typeof(revision_before) = 'integer' AND revision_before BETWEEN 1 AND 2147483646),
  revision_after INTEGER NOT NULL CHECK (typeof(revision_after) = 'integer' AND revision_after = revision_before + 1),
  ledger_event_id TEXT NOT NULL CHECK (${ID_CHECK('ledger_event_id', 'card-event-', 43)}),
  acting_owner_ref TEXT NOT NULL CHECK (${ID_CHECK('acting_owner_ref', 'usr_', 36)}),
  applied_by TEXT NOT NULL CHECK (${TEXT_CHECK('applied_by')}),
  basis TEXT NOT NULL CHECK (${TEXT_CHECK('basis')}),
  reason TEXT NOT NULL CHECK (${TEXT_CHECK('reason')}),
  created_at TEXT NOT NULL CHECK (${INSTANT_CHECK('created_at')}),
  undone_at TEXT CHECK (undone_at IS NULL OR (${INSTANT_CHECK('undone_at')})),
  undo_go_id TEXT CHECK (undo_go_id IS NULL OR (${HEX_CHECK('undo_go_id', 32)})),
  undo_event_id TEXT CHECK (undo_event_id IS NULL OR (${ID_CHECK('undo_event_id', 'card-event-', 43)})),
  undone_by TEXT CHECK (undone_by IS NULL OR (${TEXT_CHECK('undone_by')})),
  CHECK ((undone_at IS NULL) = (undo_go_id IS NULL) AND (undone_at IS NULL) = (undo_event_id IS NULL) AND (undone_at IS NULL) = (undone_by IS NULL))
)`;
const INDEX_SQL = {
  card_kind_corrections_event: 'CREATE UNIQUE INDEX card_kind_corrections_event ON card_kind_corrections (ledger_event_id)',
  card_kind_corrections_go_row: 'CREATE UNIQUE INDEX card_kind_corrections_go_row ON card_kind_corrections (go_id, card_transaction_id)',
  card_kind_corrections_undo_event: `CREATE UNIQUE INDEX card_kind_corrections_undo_event ON card_kind_corrections (undo_event_id)
  WHERE undo_event_id IS NOT NULL`,
} as const;
/**
 * Append-only, as the card ledger's own records, and bound 1:1 to the system's audit rows:
 * - a correction record is written in force, before its GO is recorded, with its own `corrected` event and exactly one
 *   audit row for that event, the system's `operator-kind-correction` row for the same account and revisions;
 * - it changes once, by being undone before its undo GO is recorded, with the opposite `corrected` event and exactly one
 *   `operator-kind-correction-undo` audit row;
 * - a GO record, written last, seals its records: an apply GO has exactly its own records, each with its authority; an
 *   undo GO undid exactly its own records of a recorded apply; and every audit row of either code anywhere is bound: the
 *   only audit row of its event, and the audit row of exactly one correction record (no duplicate, no orphan). A
 *   recorded GO takes no more records, and never changes.
 * No record is deleted or replaced. The guarded audit table itself takes no trigger of this module's (Root ruling
 * 16:56Z), so an unbound row written there directly is not refused as it is written: plan reports it, and every apply,
 * undo and seal refuses while one exists.
 */
const TRIGGER_SQL = {
  card_kind_correction_gos_insert: `CREATE TRIGGER card_kind_correction_gos_insert BEFORE INSERT ON card_kind_correction_gos
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM card_kind_correction_gos x WHERE x.rowid = NEW.rowid OR x.go_id = NEW.go_id)
      THEN RAISE(ABORT, 'card kind correction GOs are never replaced')
    WHEN EXISTS (SELECT 1 FROM card_sync_audit_events a WHERE a.event_type = 'ledger-maintenance'
        AND a.code IN ('operator-kind-correction', 'operator-kind-correction-undo')
        AND ((SELECT count(*) FROM card_sync_audit_events b WHERE b.event_type = 'ledger-maintenance' AND b.ledger_event_id = a.ledger_event_id) <> 1
          OR (SELECT count(*) FROM card_kind_corrections k WHERE (a.code = 'operator-kind-correction' AND k.ledger_event_id = a.ledger_event_id)
            OR (a.code = 'operator-kind-correction-undo' AND k.undo_event_id = a.ledger_event_id)) <> 1))
      THEN RAISE(ABORT, 'every operator kind-correction audit row is bound to exactly one correction record')
    WHEN NEW.command = 'apply' AND ((SELECT count(*) FROM card_kind_corrections k WHERE k.go_id = NEW.go_id) <> NEW.row_count
        OR EXISTS (SELECT 1 FROM card_kind_corrections k WHERE k.go_id = NEW.go_id AND (k.undone_at IS NOT NULL
          OR k.preview_digest IS NOT NEW.preview_digest OR k.acting_owner_ref IS NOT NEW.acting_owner_ref
          OR k.applied_by IS NOT NEW.applied_by OR k.basis IS NOT NEW.basis OR k.reason IS NOT NEW.reason)))
      THEN RAISE(ABORT, 'an apply GO records exactly its own corrections')
    WHEN NEW.command = 'undo' AND (NOT EXISTS (SELECT 1 FROM card_kind_correction_gos x WHERE x.go_id = NEW.applied_go_id AND x.command = 'apply')
        OR (SELECT count(*) FROM card_kind_corrections k WHERE k.undo_go_id = NEW.go_id) <> NEW.row_count
        OR EXISTS (SELECT 1 FROM card_kind_corrections k WHERE k.undo_go_id = NEW.go_id
          AND (k.go_id IS NOT NEW.applied_go_id OR k.undone_by IS NOT NEW.applied_by)))
      THEN RAISE(ABORT, 'an undo GO records exactly its own undos of a recorded apply')
  END;
END`,
  card_kind_correction_gos_no_update: `CREATE TRIGGER card_kind_correction_gos_no_update BEFORE UPDATE ON card_kind_correction_gos
BEGIN SELECT RAISE(ABORT, 'card kind correction GOs never change'); END`,
  card_kind_correction_gos_no_delete: `CREATE TRIGGER card_kind_correction_gos_no_delete BEFORE DELETE ON card_kind_correction_gos
BEGIN SELECT RAISE(ABORT, 'card kind correction GOs are never deleted'); END`,
  card_kind_corrections_insert: `CREATE TRIGGER card_kind_corrections_insert BEFORE INSERT ON card_kind_corrections
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM card_kind_corrections x WHERE x.rowid = NEW.rowid OR x.id = NEW.id OR x.ledger_event_id = NEW.ledger_event_id
        OR (x.go_id = NEW.go_id AND x.card_transaction_id = NEW.card_transaction_id))
      THEN RAISE(ABORT, 'card kind corrections are never replaced')
    WHEN NEW.undone_at IS NOT NULL
      THEN RAISE(ABORT, 'a card kind correction is recorded in force')
    WHEN EXISTS (SELECT 1 FROM card_kind_correction_gos g WHERE g.go_id = NEW.go_id)
      THEN RAISE(ABORT, 'a recorded GO takes no more corrections')
    WHEN (SELECT count(*) FROM card_sync_audit_events a WHERE a.event_type = 'ledger-maintenance' AND a.ledger_event_id = NEW.ledger_event_id) <> 1
      OR NOT EXISTS (SELECT 1 FROM card_sync_audit_events a WHERE a.event_type = 'ledger-maintenance' AND a.ledger_event_id = NEW.ledger_event_id
        AND a.actor_kind = 'system' AND a.code = 'operator-kind-correction' AND a.card_account_id = NEW.card_account_id
        AND a.version_before = NEW.revision_before AND a.version_after = NEW.revision_after)
      THEN RAISE(ABORT, 'a card kind correction has exactly one system audit row of its own')
    WHEN NOT EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.id = NEW.ledger_event_id AND e.event_type = 'corrected'
        AND e.card_transaction_id = NEW.card_transaction_id AND e.card_account_id = NEW.card_account_id
        AND e.transaction_revision = NEW.revision_after AND e.from_kind = NEW.from_kind AND e.to_kind = NEW.to_kind
        AND e.origin = 'session' AND e.actor_ref = NEW.acting_owner_ref)
      THEN RAISE(ABORT, 'a card kind correction records its own ledger event')
  END;
END`,
  card_kind_corrections_update: `CREATE TRIGGER card_kind_corrections_update BEFORE UPDATE ON card_kind_corrections
BEGIN
  SELECT CASE
    WHEN OLD.undone_at IS NOT NULL
      THEN RAISE(ABORT, 'an undone card kind correction never changes')
    WHEN NEW.undone_at IS NULL
      THEN RAISE(ABORT, 'a card kind correction changes only by being undone')
    WHEN NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.go_id IS NOT OLD.go_id OR NEW.preview_digest IS NOT OLD.preview_digest
        OR NEW.card_transaction_id IS NOT OLD.card_transaction_id OR NEW.card_account_id IS NOT OLD.card_account_id
        OR NEW.from_kind IS NOT OLD.from_kind OR NEW.to_kind IS NOT OLD.to_kind OR NEW.revision_before IS NOT OLD.revision_before
        OR NEW.revision_after IS NOT OLD.revision_after OR NEW.ledger_event_id IS NOT OLD.ledger_event_id
        OR NEW.acting_owner_ref IS NOT OLD.acting_owner_ref OR NEW.applied_by IS NOT OLD.applied_by OR NEW.basis IS NOT OLD.basis
        OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'a card kind correction keeps what it recorded')
    WHEN EXISTS (SELECT 1 FROM card_kind_corrections x WHERE x.undo_event_id = NEW.undo_event_id AND x.rowid IS NOT OLD.rowid)
      THEN RAISE(ABORT, 'card kind corrections are never replaced')
    WHEN NOT EXISTS (SELECT 1 FROM card_kind_correction_gos g WHERE g.go_id = OLD.go_id AND g.command = 'apply')
        OR EXISTS (SELECT 1 FROM card_kind_correction_gos g WHERE g.go_id = NEW.undo_go_id)
      THEN RAISE(ABORT, 'a card kind correction of a recorded apply is undone before its undo GO is recorded')
    WHEN (SELECT count(*) FROM card_sync_audit_events a WHERE a.event_type = 'ledger-maintenance' AND a.ledger_event_id = NEW.undo_event_id) <> 1
      OR NOT EXISTS (SELECT 1 FROM card_sync_audit_events a WHERE a.event_type = 'ledger-maintenance' AND a.ledger_event_id = NEW.undo_event_id
        AND a.actor_kind = 'system' AND a.code = 'operator-kind-correction-undo' AND a.card_account_id = OLD.card_account_id)
      THEN RAISE(ABORT, 'a card kind correction is undone with exactly one system undo audit row of its own')
    WHEN NOT EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.id = NEW.undo_event_id AND e.event_type = 'corrected'
        AND e.card_transaction_id = OLD.card_transaction_id AND e.from_kind = OLD.to_kind AND e.to_kind = OLD.from_kind)
      THEN RAISE(ABORT, 'a card kind correction records its own undo event')
  END;
END`,
  card_kind_corrections_no_delete: `CREATE TRIGGER card_kind_corrections_no_delete BEFORE DELETE ON card_kind_corrections
BEGIN SELECT RAISE(ABORT, 'card kind corrections are never deleted'); END`,
} as const;
export const CARD_KIND_CORRECTIONS_SCHEMA_SQL: readonly string[] = [
  GOS_SQL, TABLE_SQL, ...Object.values(INDEX_SQL), ...Object.values(TRIGGER_SQL),
];

const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const EXPECTED_OBJECTS: ReadonlyMap<string, { type: string; sql: string | null }> = new Map([
  [GOS_TABLE, { type: 'table', sql: normalizeSql(GOS_SQL) }],
  [`sqlite_autoindex_${GOS_TABLE}_1`, { type: 'index', sql: null }],
  [TABLE, { type: 'table', sql: normalizeSql(TABLE_SQL) }],
  [`sqlite_autoindex_${TABLE}_1`, { type: 'index', sql: null }],
  ...Object.entries(INDEX_SQL).map(([name, sql]) => [name, { type: 'index', sql: normalizeSql(sql) }] as const),
  ...Object.entries(TRIGGER_SQL).map(([name, sql]) => [name, { type: 'trigger', sql: normalizeSql(sql) }] as const),
]);
export const CARD_KIND_CORRECTIONS_SCHEMA_DIGEST = digest(CARD_KIND_CORRECTIONS_SCHEMA_SQL.map(normalizeSql));

/**
 * What the rules read: the card import tool's own kind rules (shared cardKinds.ts), on rows the tool stored from a
 * format whose kinds come from those rules; the wording the value-free reconciliation check read as a payment's; and
 * the days they look around a row for a same-card payment and for a checking debit of its size.
 */
export const CARD_KIND_CORRECTION_RULES = Object.freeze({
  reading: 'classifyCardKind', storedBy: 'holdr-card-import', exportSetKinds: Object.freeze(['bilt-csv']),
  wording: 'payment-pmt-pymt', sameCardPaymentDays: 30, checkingDebitDays: 15,
});
const TOOL_PARSER = /^holdr-card-import@/;
const TOOL_PARSER_LABEL = /^holdr-card-import@\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const CARD_KIND_CORRECTION_REFUSALS = Object.freeze({
  conflict: 'the card kind correction tables already exist in another shape; nothing was written',
  unverified: 'the card kind correction tables did not install as expected; nothing was installed',
  notInstalled: 'card kind corrections are not installed on this Holdr; install the tables first',
  checkingMissing: 'the checking ledger is not installed, so the rules cannot check the checking debits; nothing was written',
  previewChanged: 'the rows the rules choose are not the ones the GO names; plan again',
  nothingToApply: 'the plan corrects no row; nothing was written',
  rowChanged: 'a chosen row changed since the plan; plan again',
  owner: 'actingOwnerRef names no local owner of this Holdr',
  goUsed: 'a GO with that goId is already recorded with other contents; nothing was written',
  unboundAudit: 'an operator kind-correction audit row is not bound to exactly one correction record; nothing was written',
  nothingToUndo: 'that GO corrected no row that can be undone now; plan the undo again',
  recordMismatch: 'a correction record does not match its ledger event; nothing was written',
});

export type CardKindCorrectionsSchemaState = 'present' | 'absent' | 'conflict';

/** Read-only: `present` only for exactly this build's table and indexes, `absent` when nothing has their names. */
export function cardKindCorrectionsSchemaState(db: Database): CardKindCorrectionsSchemaState {
  try {
    const names = [...EXPECTED_OBJECTS.keys()];
    const objects = db.prepare(`SELECT type, name, sql FROM main.sqlite_master
      WHERE name COLLATE NOCASE IN (${names.map(() => '?').join(', ')}) OR tbl_name COLLATE NOCASE IN (?, ?)`)
      .all(...names, TABLE, GOS_TABLE) as Array<{ type: unknown; name: unknown; sql: unknown }>;
    if (objects.length === 0) return 'absent';
    const present = objects.length === EXPECTED_OBJECTS.size && objects.every((object) => {
      const expected = typeof object.name === 'string' ? EXPECTED_OBJECTS.get(object.name) : undefined;
      if (!expected || object.type !== expected.type) return false;
      return expected.sql === null ? object.sql === null : typeof object.sql === 'string' && normalizeSql(object.sql) === expected.sql;
    });
    return present ? 'present' : 'conflict';
  } catch (error) {
    throw toValueFreeDbError('read card kind corrections schema', error);
  }
}

/** Only the operator command calls this, inside its backed-up IMMEDIATE transaction: nothing when there, else the table. */
export function installCardKindCorrectionsSchema(db: Database): void {
  try {
    db.transaction(() => {
      const state = cardKindCorrectionsSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.conflict);
      for (const sql of CARD_KIND_CORRECTIONS_SCHEMA_SQL) db.exec(sql);
      if (cardKindCorrectionsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.unverified);
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('install card kind corrections', error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules: which rows
// ---------------------------------------------------------------------------------------------------------------------

/** A checking row as the checking ledger's reader lists it (posted only; money out negative). */
export interface KindCorrectionCheckingRow {
  date: string;
  amountMinor: number;
  description: string;
}

/** What a row's own text says, as the value-free reconciliation check read it (first that applies). */
export function paymentWording(text: string): 'returned' | 'reversed' | 'adjustment' | 'refund' | 'credit' | 'payment-word' | 'other' {
  const plain = text.toUpperCase();
  if (/RETURN/.test(plain)) return 'returned';
  if (/REVERS/.test(plain)) return 'reversed';
  if (/ADJUST/.test(plain)) return 'adjustment';
  if (/REFUND/.test(plain)) return 'refund';
  if (/CREDIT/.test(plain)) return 'credit';
  if (/PAYMENT|PMT|PYMT/.test(plain)) return 'payment-word';
  return 'other';
}

export type KindCorrectionExclusion =
  | 'not-from-the-converter'
  | 'export-sets-kind'
  | 'converter-reads-payment'
  | 'return-or-credit-wording'
  | 'other-payment-wording'
  | 'no-payment-wording'
  | 'same-card-payment-within-30-days'
  | 'card-payment-debit-within-15-days';

export interface KindCorrectionRow {
  transactionId: string;
  cardAccountId: string;
  /** `issuer:last4` of the card account (last4, or an Amex last five's last four; `none` without). */
  card: string;
  transactionDate: string;
  revision: number;
  fromKind: CardTransactionKind;
  toKind: CardTransactionKind;
}

export interface KindCorrectionPlan {
  rows: KindCorrectionRow[];
  /** Candidates (posted payments that add to the balance) the rules leave alone, with the first rule that kept them. */
  excluded: Array<{ card: string; transactionDate: string; reason: KindCorrectionExclusion }>;
  /** The tool versions that stored the chosen rows (`holdr-card-import@x.y.z`), with how many rows each. */
  parserVersions: Record<string, number>;
  /** Open or decided review items whose candidate is one of the chosen rows: a refresh supersedes them once corrected. */
  reviewItems: { count: number; setIds: string[] };
  /** Posted rows Spending counts (`cardSpendingRole` spending), before and after the corrections. */
  spendingRows: { before: number; after: number };
  previewDigest: string;
}

interface CandidateRecord {
  id: string; card_account_id: string; status: string; kind: string; amount_minor: number; currency: string; transaction_date: string;
  description: string; issuer_category: string | null; revision: number; issuer: string; last4: string | null; last5: string | null;
  batch_source: string | null; parser_version: string | null;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const KNOWN_ISSUERS: ReadonlySet<string> = new Set(['amex', 'bilt', 'bofa', 'capitalone', 'chase', 'citi', 'discover', 'wellsfargo',
  'wells-fargo']);
/**
 * An issuer as value-free output may show it: a known issuer's slug, or a custom slug with every digit (and anything but
 * letters and hyphens) taken out, at most 16 characters; `card` when no letter is left. A custom slug's digits never show.
 */
export function kindCorrectionIssuerLabel(issuer: string): string {
  if (KNOWN_ISSUERS.has(issuer)) return issuer;
  const name = issuer.toLowerCase().replace(/[^a-z-]+/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '');
  return /[a-z]/.test(name) ? name : 'card';
}
const cardLabel = (row: { issuer: string; last4: string | null; last5: string | null }) => `${kindCorrectionIssuerLabel(row.issuer)}:${
  row.last4 && /^\d{4}$/.test(row.last4) ? row.last4 : row.last5 && /^\d{5}$/.test(row.last5) ? row.last5.slice(1) : 'none'}`;
const isKind = (value: string): value is CardTransactionKind => (CARD_IMPORT_KINDS as readonly string[]).includes(value);

/**
 * The plan: every row the rules correct now, the candidates they leave alone and why, and the digest a GO names.
 * Read-only; also the first step of apply, inside its transaction.
 */
export function planKindCorrections(db: Database, checkingRows: readonly KindCorrectionCheckingRow[]): KindCorrectionPlan {
  const rules = CARD_KIND_CORRECTION_RULES;
  const candidates = db.prepare(`SELECT t.id, t.card_account_id, t.status, t.kind, t.amount_minor, t.currency, t.transaction_date,
      t.description, t.issuer_category, t.revision, a.issuer, a.last4, a.last5, b.source AS batch_source, b.parser_version
    FROM card_transactions t JOIN card_accounts a ON a.id = t.card_account_id
      LEFT JOIN card_import_batches b ON b.id = t.import_batch_id
    WHERE t.status = 'posted' AND t.kind = 'payment' AND t.amount_minor > 0
    ORDER BY t.transaction_date, t.id`).all() as CandidateRecord[];
  const payments = db.prepare(`SELECT card_account_id, transaction_date, amount_minor FROM card_transactions
    WHERE kind = 'payment' AND status IN ('pending', 'posted') AND amount_minor < 0`).all() as
    Array<{ card_account_id: string; transaction_date: string; amount_minor: number }>;
  const payingDebits = checkingRows.filter((row) => row.amountMinor < 0 && classifyCheckingDebit(row.description).class !== 'other');

  const rows: KindCorrectionRow[] = [];
  const excluded: KindCorrectionPlan['excluded'] = [];
  const parserVersions: Record<string, number> = {};
  for (const candidate of candidates) {
    const card = cardLabel(candidate);
    const day = dayNumber(candidate.transaction_date);
    const size = candidate.amount_minor;
    const reading = classifyCardKind({ amountMinor: size, description: candidate.description, issuerCategory: candidate.issuer_category });
    const wording = paymentWording(candidate.description);
    let reason: KindCorrectionExclusion | null = null;
    // Only the tool's own reading can be taken again: a row synced from the extension, or written by another producer,
    // got its kind elsewhere, and bilt-csv's layout sets the kind of its account rows itself.
    if (candidate.parser_version === null || !TOOL_PARSER.test(candidate.parser_version)) reason = 'not-from-the-converter';
    else if (candidate.batch_source !== null && rules.exportSetKinds.includes(candidate.batch_source)) reason = 'export-sets-kind';
    else if (reading === 'payment') reason = 'converter-reads-payment';
    // The ruled wording is the reconciliation check's; a payment word only the tool's rules know is listed apart.
    else if (wording === 'other') reason = hasCardPaymentWord(candidate.description) ? 'other-payment-wording' : 'no-payment-wording';
    else if (wording !== 'payment-word') reason = 'return-or-credit-wording';
    else if (payments.some((p) => p.card_account_id === candidate.card_account_id && p.amount_minor === -size
      && Math.abs(dayNumber(p.transaction_date) - day) <= rules.sameCardPaymentDays)) reason = 'same-card-payment-within-30-days';
    else if (payingDebits.some((d) => d.amountMinor === -size && Math.abs(dayNumber(d.date) - day) <= rules.checkingDebitDays)) {
      reason = 'card-payment-debit-within-15-days';
    }
    if (reason !== null) {
      excluded.push({ card, transactionDate: candidate.transaction_date, reason });
      continue;
    }
    if (!isKind(candidate.kind)) continue;
    rows.push({ transactionId: candidate.id, cardAccountId: candidate.card_account_id, card, transactionDate: candidate.transaction_date,
      revision: candidate.revision, fromKind: candidate.kind, toKind: reading });
    const parser = TOOL_PARSER_LABEL.test(candidate.parser_version!) ? candidate.parser_version! : 'holdr-card-import@other';
    parserVersions[parser] = (parserVersions[parser] ?? 0) + 1;
  }

  const ids = JSON.stringify(rows.map((row) => row.transactionId));
  const items = db.prepare(`SELECT DISTINCT s.id, s.observation_set_id FROM card_reconciliation_suggestions s
      JOIN card_reconciliation_candidates c ON c.review_item_id = s.id
    WHERE s.status IN ('open', 'decided') AND c.transaction_id IN (SELECT value FROM json_each(?))`).all(ids) as
    Array<{ id: string; observation_set_id: string }>;
  const kinds = db.prepare(`SELECT kind, count(*) AS n FROM card_transactions WHERE status = 'posted' GROUP BY kind`).all() as
    Array<{ kind: string; n: number }>;
  const spendingBefore = kinds.filter((k) => isKind(k.kind) && cardSpendingRole(k.kind) === 'spending').reduce((sum, k) => sum + k.n, 0);
  const gained = rows.filter((row) => cardSpendingRole(row.toKind) === 'spending' && cardSpendingRole(row.fromKind) !== 'spending').length;
  const lost = rows.filter((row) => cardSpendingRole(row.fromKind) === 'spending' && cardSpendingRole(row.toKind) !== 'spending').length;

  const pinned = [...rows].sort((a, b) => (a.transactionId < b.transactionId ? -1 : 1)).map((row) => ({
    transactionId: row.transactionId, revision: row.revision, fromKind: row.fromKind, toKind: row.toKind,
  }));
  return {
    rows, excluded, parserVersions: Object.fromEntries(Object.entries(parserVersions).sort(([a], [b]) => (a < b ? -1 : 1))),
    reviewItems: { count: items.length, setIds: [...new Set(items.map((item) => item.observation_set_id))].sort() },
    spendingRows: { before: spendingBefore, after: spendingBefore + gained - lost },
    previewDigest: digest({ format: 'holdr.card-kind-corrections-plan', version: 1, rules, rows: pinned }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Apply and undo
// ---------------------------------------------------------------------------------------------------------------------

/** Who acted and why, as the GO says; the GO record, every correction record and the receipt carry it. */
export interface KindCorrectionAuthority {
  goId: string;
  /** The digest of the whole GO artifact as parsed: a replay must be this same artifact. */
  goDigest: string;
  purpose: string;
  previewDigest: string;
  /** The owner on whose standing order the operator acts: the ledger event's actor, the only kind the schema allows. */
  actingOwnerRef: string;
  /** e.g. `operator 6a592dcc under ROOT GO <goId>`. */
  appliedBy: string;
  basis: string;
  reason: string;
}

export interface KindCorrectionReceipt {
  rows: number;
  byCard: Record<string, string[]>;
  reviewItemsSuperseded: number;
  spendingRows: { before: number; after: number };
}

/** Whether `actingOwnerRef` is the card-sync actor of a local owner of this Holdr (cardSyncActorRef of a local user). */
export function isLocalOwnerRef(db: Database, actingOwnerRef: string): boolean {
  const ids = db.prepare('SELECT id FROM local_users').pluck().all() as string[];
  return ids.some((id) => cardSyncActorRef(id) === actingOwnerRef);
}

/** The GO recorded under `goId`, if any. A replay is the same command with the same artifact digest; anything else is refused. */
export function kindCorrectionGo(db: Database, goId: string): { command: 'apply' | 'undo'; goDigest: string; rows: number } | null {
  if (cardKindCorrectionsSchemaState(db) !== 'present') return null;
  const row = db.prepare('SELECT command, go_digest, row_count FROM card_kind_correction_gos WHERE go_id = ?').get(goId) as
    { command: 'apply' | 'undo'; go_digest: string; row_count: number } | undefined;
  return row ? { command: row.command, goDigest: row.go_digest, rows: row.row_count } : null;
}

/**
 * Audit rows of this command's codes (`operator-kind-correction`, `-undo`) that are not bound 1:1: another audit row
 * names the same ledger event (a duplicate), or not exactly one correction record has that event as its own (an
 * orphan); without the tables installed, every such row. Apply and undo refuse while any exists, and a GO's seal
 * refuses one too. (A record's own audit row may be gone only by the audit retention, 365 days on: that is no
 * violation here.)
 */
export function kindCorrectionUnboundAuditRows(db: Database): number {
  const recorded = cardKindCorrectionsSchemaState(db) === 'present'
    ? `(SELECT count(*) FROM card_kind_corrections k WHERE (a.code = 'operator-kind-correction' AND k.ledger_event_id = a.ledger_event_id)
        OR (a.code = 'operator-kind-correction-undo' AND k.undo_event_id = a.ledger_event_id))`
    : '0';
  return db.prepare(`SELECT count(*) FROM card_sync_audit_events a WHERE a.event_type = 'ledger-maintenance'
    AND a.code IN ('operator-kind-correction', 'operator-kind-correction-undo')
    AND ((SELECT count(*) FROM card_sync_audit_events b WHERE b.event_type = 'ledger-maintenance' AND b.ledger_event_id = a.ledger_event_id) <> 1
      OR ${recorded} <> 1)`).pluck().get() as number;
}

/** The GO's own record, written last: its trigger seals the GO's records (see TRIGGER_SQL). */
function recordGo(db: Database, authority: KindCorrectionAuthority, input: {
  command: 'apply' | 'undo'; appliedGoId: string | null; rows: number; now: string;
}): void {
  if (kindCorrectionGo(db, authority.goId) !== null) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.goUsed);
  db.prepare(`INSERT INTO card_kind_correction_gos (go_id, command, purpose, go_digest, preview_digest, applied_go_id, acting_owner_ref,
      applied_by, basis, reason, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(authority.goId, input.command, authority.purpose, authority.goDigest, authority.previewDigest, input.appliedGoId,
      authority.actingOwnerRef, authority.appliedBy, authority.basis, authority.reason, input.rows, input.now);
}

function context(db: Database, now: string, guardRevision: number): CardSyncContext {
  return { db, now, statements: new CardSyncStatements(db), guardRevision };
}

const byCardOf = (rows: ReadonlyArray<{ card: string; transactionDate: string }>) => {
  const out: Record<string, string[]> = {};
  for (const row of rows) (out[row.card] ??= []).push(row.transactionDate);
  for (const dates of Object.values(out)) dates.sort();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/** Refreshes the review sets that ask about the given rows (a system refresh); returns how many of their items it closed. */
function refreshSets(ctx: CardSyncContext, setIds: readonly string[], itemIdsBefore: readonly string[]): number {
  for (const setId of setIds) refreshCardReviewItems(ctx, { setId });
  if (itemIdsBefore.length === 0) return 0;
  return ctx.db.prepare(`SELECT count(*) FROM card_reconciliation_suggestions WHERE status = 'superseded'
    AND id IN (SELECT value FROM json_each(?))`).pluck().get(JSON.stringify(itemIdsBefore)) as number;
}

function openItemIds(db: Database, transactionIds: readonly string[]): string[] {
  return (db.prepare(`SELECT DISTINCT s.id FROM card_reconciliation_suggestions s
      JOIN card_reconciliation_candidates c ON c.review_item_id = s.id
    WHERE s.status IN ('open', 'decided') AND c.transaction_id IN (SELECT value FROM json_each(?))`)
    .pluck().all(JSON.stringify(transactionIds)) as string[]);
}

const spendingRowCount = (db: Database) => (db.prepare(`SELECT kind, count(*) AS n FROM card_transactions WHERE status = 'posted'
  GROUP BY kind`).all() as Array<{ kind: string; n: number }>)
  .filter((k) => isKind(k.kind) && cardSpendingRole(k.kind) === 'spending').reduce((sum, k) => sum + k.n, 0);

/** One reversible kind change of a row at its pinned revision, its `corrected` event and the system's audit row. */
function correctRow(ctx: CardSyncContext, writer: CardLedgerWriter, input: {
  transactionId: string; expectedRevision: number; fromKind: CardTransactionKind; toKind: CardTransactionKind; actingOwnerRef: string;
  auditCode: 'operator-kind-correction' | 'operator-kind-correction-undo';
}): { eventId: string; revision: number; cardAccountId: string } {
  const row = writer.trackedRow(input.transactionId);
  if (!row || row.revision !== input.expectedRevision || row.kind !== input.fromKind || row.status !== 'posted') {
    throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.rowChanged);
  }
  const values = { ...row, kind: input.toKind };
  const revision = writer.writeTrackedRow({ id: row.id, cardAccountId: row.cardAccountId, expectedRevision: row.revision, values,
    marker: row.revision });
  const eventId = writer.recordEvent({
    transactionId: row.id, cardAccountId: row.cardAccountId, type: 'corrected', revision, origin: 'session',
    actor: { kind: 'session', ref: input.actingOwnerRef }, reason: 'posted-correction',
    fromStatus: row.status, toStatus: values.status, fromAmountMinor: row.amountMinor, toAmountMinor: values.amountMinor,
    fromTransactionDate: row.transactionDate, toTransactionDate: values.transactionDate, fromPostedDate: row.postedDate,
    toPostedDate: values.postedDate, fromKind: row.kind, toKind: values.kind, notify: materialChange(row, values),
  });
  audit(ctx, 'ledger-maintenance', { kind: 'system' }, {
    cardAccountId: row.cardAccountId, code: input.auditCode, ledgerEventId: eventId, versionBefore: row.revision, versionAfter: revision,
  });
  return { eventId, revision, cardAccountId: row.cardAccountId };
}

/**
 * Applies the plan the GO names, inside the caller's IMMEDIATE transaction (the operator's backed-up write): the plan is
 * computed again and must have the GO's digest and at least one row, and every operator audit row must be bound; each
 * row then gets its correction, event and system audit row; then, once the ledger has written its events (on finish),
 * each row's correction record, bound to its event and audit row; then the GO's record, which seals them; and the review
 * sets that asked about the rows are refreshed.
 */
export function applyKindCorrections(db: Database, input: KindCorrectionAuthority & {
  now: string; guardRevision: number; checkingRows: readonly KindCorrectionCheckingRow[];
}): KindCorrectionReceipt {
  if (cardKindCorrectionsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.notInstalled);
  if (kindCorrectionGo(db, input.goId) !== null) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.goUsed);
  if (kindCorrectionUnboundAuditRows(db) > 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.unboundAudit);
  if (!isLocalOwnerRef(db, input.actingOwnerRef)) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.owner);
  const plan = planKindCorrections(db, input.checkingRows);
  if (plan.previewDigest !== input.previewDigest) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.previewChanged);
  if (plan.rows.length === 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.nothingToApply);
  const ctx = context(db, input.now, input.guardRevision);
  const itemsBefore = openItemIds(db, plan.rows.map((row) => row.transactionId));
  const writer = new CardLedgerWriter(db, input.now);
  const done = plan.rows.map((row) => ({ row, ...correctRow(ctx, writer, { transactionId: row.transactionId,
    expectedRevision: row.revision, fromKind: row.fromKind, toKind: row.toKind, actingOwnerRef: input.actingOwnerRef,
    auditCode: 'operator-kind-correction' }) }));
  writer.finish();
  const insert = db.prepare(`INSERT INTO card_kind_corrections (id, go_id, preview_digest, card_transaction_id, card_account_id,
      from_kind, to_kind, revision_before, revision_after, ledger_event_id, acting_owner_ref, applied_by, basis, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const { row, eventId, revision, cardAccountId } of done) {
    insert.run(`kcr_${randomCardSyncLetters()}`, input.goId, input.previewDigest, row.transactionId, cardAccountId, row.fromKind,
      row.toKind, row.revision, revision, eventId, input.actingOwnerRef, input.appliedBy, input.basis, input.reason, input.now);
  }
  recordGo(db, input, { command: 'apply', appliedGoId: null, rows: plan.rows.length, now: input.now });
  const superseded = refreshSets(ctx, plan.reviewItems.setIds, itemsBefore);
  return { rows: plan.rows.length, byCard: byCardOf(plan.rows), reviewItemsSuperseded: superseded, spendingRows: plan.spendingRows };
}

export type KindCorrectionUndoSkip = 'record-mismatch' | 'undone-already' | 'reverted-by-owner' | 'changed-since';

export interface KindCorrectionUndoPlan {
  /** Corrections of the applied GO that can be undone now: the row is still at the corrected revision and kind. */
  rows: Array<KindCorrectionRow & { correctionId: string; ledgerEventId: string }>;
  /**
   * Corrections of that GO left as they are, and why: a record that does not match its ledger event (the undo then
   * refuses), undone already, reverted in the owner's history, or changed since.
   */
  skipped: Array<{ card: string; transactionDate: string; reason: KindCorrectionUndoSkip }>;
  previewDigest: string;
}

interface UndoRecord {
  correction_id: string; card_transaction_id: string; card_account_id: string; from_kind: string; to_kind: string; revision_after: number;
  ledger_event_id: string; acting_owner_ref: string; undone_at: string | null;
  event_id: string | null; event_type: string | null; event_transaction_id: string | null; event_account_id: string | null;
  event_revision: number | null; event_from_kind: string | null; event_to_kind: string | null; event_origin: string | null;
  event_actor_ref: string | null; audit_rows: number; audit_own: number; go_recorded: number;
  transaction_id: string | null; status: string | null; kind: string | null; revision: number | null; transaction_date: string | null;
  issuer: string | null; last4: string | null; last5: string | null; reverted: number;
}

/**
 * Which corrections of `appliedGoId` the undo would set back, read-only; the undo GO names its digest, which pins each
 * row's record, ledger event, revision and both kinds. The kinds are the ledger event's: every record must match the
 * append-only event it names, have exactly its one system audit row, and belong to a recorded apply GO, or it is listed
 * as a mismatch and the undo refuses.
 */
export function planKindCorrectionUndo(db: Database, appliedGoId: string): KindCorrectionUndoPlan {
  const digestOf = (rows: KindCorrectionUndoPlan['rows']) => digest({ format: 'holdr.card-kind-corrections-undo', version: 1, appliedGoId,
    rows: [...rows].sort((a, b) => (a.transactionId < b.transactionId ? -1 : 1)).map((row) => ({ correctionId: row.correctionId,
      transactionId: row.transactionId, ledgerEventId: row.ledgerEventId, revision: row.revision, fromKind: row.fromKind,
      toKind: row.toKind })) });
  if (cardKindCorrectionsSchemaState(db) !== 'present') return { rows: [], skipped: [], previewDigest: digestOf([]) };
  const records = db.prepare(`SELECT k.id AS correction_id, k.card_transaction_id, k.card_account_id, k.from_kind, k.to_kind,
      k.revision_after, k.ledger_event_id, k.acting_owner_ref, k.undone_at,
      e.id AS event_id, e.event_type, e.card_transaction_id AS event_transaction_id, e.card_account_id AS event_account_id,
      e.transaction_revision AS event_revision, e.from_kind AS event_from_kind, e.to_kind AS event_to_kind, e.origin AS event_origin,
      e.actor_ref AS event_actor_ref,
      (SELECT count(*) FROM card_sync_audit_events au WHERE au.event_type = 'ledger-maintenance'
        AND au.ledger_event_id = k.ledger_event_id) AS audit_rows,
      EXISTS (SELECT 1 FROM card_sync_audit_events au WHERE au.event_type = 'ledger-maintenance' AND au.ledger_event_id = k.ledger_event_id
        AND au.actor_kind = 'system' AND au.code = 'operator-kind-correction' AND au.card_account_id = k.card_account_id) AS audit_own,
      EXISTS (SELECT 1 FROM card_kind_correction_gos g WHERE g.go_id = k.go_id AND g.command = 'apply') AS go_recorded,
      t.id AS transaction_id, t.status, t.kind, t.revision, t.transaction_date, a.issuer, a.last4, a.last5,
      EXISTS (SELECT 1 FROM card_transaction_events r WHERE r.reverses_event_id = k.ledger_event_id) AS reverted
    FROM card_kind_corrections k
      LEFT JOIN card_transaction_events e ON e.id = k.ledger_event_id
      LEFT JOIN card_transactions t ON t.id = k.card_transaction_id AND t.card_account_id = k.card_account_id
      LEFT JOIN card_accounts a ON a.id = k.card_account_id
    WHERE k.go_id = ? ORDER BY t.transaction_date, k.card_transaction_id`).all(appliedGoId) as UndoRecord[];
  const rows: KindCorrectionUndoPlan['rows'] = [];
  const skipped: KindCorrectionUndoPlan['skipped'] = [];
  for (const record of records) {
    const card = record.issuer === null ? 'card:none' : cardLabel({ issuer: record.issuer, last4: record.last4, last5: record.last5 });
    const transactionDate = record.transaction_date ?? 'unknown';
    const matches = record.event_id !== null && record.transaction_id !== null && record.event_type === 'corrected'
      && record.event_transaction_id === record.card_transaction_id && record.event_account_id === record.card_account_id
      && record.event_revision === record.revision_after && record.event_from_kind === record.from_kind
      && record.event_to_kind === record.to_kind && record.event_origin === 'session' && record.event_actor_ref === record.acting_owner_ref
      && record.audit_rows === 1 && record.audit_own === 1 && record.go_recorded === 1
      && isKind(record.from_kind) && isKind(record.to_kind);
    if (!matches) skipped.push({ card, transactionDate, reason: 'record-mismatch' });
    else if (record.undone_at !== null) skipped.push({ card, transactionDate, reason: 'undone-already' });
    else if (record.reverted === 1) skipped.push({ card, transactionDate, reason: 'reverted-by-owner' });
    else if (record.revision !== record.revision_after || record.kind !== record.event_to_kind || record.status !== 'posted') {
      skipped.push({ card, transactionDate, reason: 'changed-since' });
    } else {
      // The undo writes the opposite correction: from the event's new kind back to the kind it replaced.
      rows.push({ correctionId: record.correction_id, transactionId: record.card_transaction_id, cardAccountId: record.card_account_id,
        ledgerEventId: record.ledger_event_id, card, transactionDate, revision: record.revision,
        fromKind: record.event_to_kind as CardTransactionKind, toKind: record.event_from_kind as CardTransactionKind });
    }
  }
  return { rows, skipped, previewDigest: digestOf(rows) };
}

/**
 * Undoes the corrections the undo GO names, inside the caller's IMMEDIATE transaction, with the same honesty as apply:
 * refused when any record of the applied GO does not match its ledger event, audit row or GO, or any operator audit row
 * is unbound. Each row's record is marked undone with its own undo event and `-undo` audit row, then the undo GO's
 * record seals them.
 */
export function undoKindCorrections(db: Database, input: KindCorrectionAuthority & { appliedGoId: string; now: string; guardRevision: number }):
  KindCorrectionReceipt {
  if (cardKindCorrectionsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.notInstalled);
  if (kindCorrectionGo(db, input.goId) !== null) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.goUsed);
  if (kindCorrectionUnboundAuditRows(db) > 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.unboundAudit);
  if (!isLocalOwnerRef(db, input.actingOwnerRef)) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.owner);
  const plan = planKindCorrectionUndo(db, input.appliedGoId);
  if (plan.skipped.some((item) => item.reason === 'record-mismatch')) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.recordMismatch);
  if (plan.previewDigest !== input.previewDigest) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.previewChanged);
  if (plan.rows.length === 0) throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.nothingToUndo);
  const spendingBefore = spendingRowCount(db);
  const ctx = context(db, input.now, input.guardRevision);
  const writer = new CardLedgerWriter(db, input.now);
  const done = plan.rows.map((row) => ({ row, ...correctRow(ctx, writer, { transactionId: row.transactionId,
    expectedRevision: row.revision, fromKind: row.fromKind, toKind: row.toKind, actingOwnerRef: input.actingOwnerRef,
    auditCode: 'operator-kind-correction-undo' }) }));
  writer.finish();
  const mark = db.prepare(`UPDATE card_kind_corrections SET undone_at = ?, undo_go_id = ?, undo_event_id = ?, undone_by = ?
    WHERE id = ? AND undone_at IS NULL`);
  for (const { row, eventId } of done) {
    if (mark.run(input.now, input.goId, eventId, input.appliedBy, row.correctionId).changes !== 1) {
      throw new HoldrRefusal(CARD_KIND_CORRECTION_REFUSALS.rowChanged);
    }
  }
  recordGo(db, input, { command: 'undo', appliedGoId: input.appliedGoId, rows: plan.rows.length, now: input.now });
  const setIds = (db.prepare(`SELECT DISTINCT id FROM card_sync_observation_sets WHERE card_account_id IN (SELECT value FROM json_each(?))`)
    .pluck().all(JSON.stringify([...new Set(plan.rows.map((row) => row.cardAccountId))])) as string[]);
  for (const setId of setIds) refreshCardReviewItems(ctx, { setId });
  const lost = plan.rows.filter((row) => cardSpendingRole(row.fromKind) === 'spending' && cardSpendingRole(row.toKind) !== 'spending').length;
  return { rows: plan.rows.length, byCard: byCardOf(plan.rows), reviewItemsSuperseded: 0,
    spendingRows: { before: spendingBefore, after: spendingBefore - lost } };
}

/** Every correction recorded, by state: in force, undone by the command, or reverted in the owner's history. */
export function kindCorrectionsStatus(db: Database): { inForce: number; undone: number; revertedByOwner: number } | null {
  if (cardKindCorrectionsSchemaState(db) !== 'present') return null;
  const row = db.prepare(`SELECT
      sum(CASE WHEN undone_at IS NULL AND NOT EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.reverses_event_id = k.ledger_event_id)
        THEN 1 ELSE 0 END) AS inForce,
      sum(CASE WHEN undone_at IS NOT NULL THEN 1 ELSE 0 END) AS undone,
      sum(CASE WHEN undone_at IS NULL AND EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.reverses_event_id = k.ledger_event_id)
        THEN 1 ELSE 0 END) AS revertedByOwner
    FROM card_kind_corrections k`).get() as { inForce: number | null; undone: number | null; revertedByOwner: number | null };
  return { inForce: row.inForce ?? 0, undone: row.undone ?? 0, revertedByOwner: row.revertedByOwner ?? 0 };
}
