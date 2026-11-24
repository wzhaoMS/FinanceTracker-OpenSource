import type { Database } from 'better-sqlite3';
import {
  CARD_PAYMENT_DECISION_KINDS,
  CARD_PAYMENT_RECONCILIATION_RULES,
  type CardPaymentDecision,
  type CardPaymentDecisionKind,
} from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import { randomCardSyncLetters } from './cardSyncDigests.js';
import { HoldrRefusal, toValueFreeDbError } from './dbErrors.js';

/**
 * The owner's word on card payments and the checking debits that paid them (shared cardPaymentReconciliation.ts):
 * this payment was paid by that debit (`confirmed`), it was not (`rejected`), this payment was paid from another
 * account (`elsewhere`), this debit is not a card payment (`not-card-payment`). One table, `card_payment_decisions`.
 * Nothing creates it at boot: only the backed-up, Root-GO-gated operator command (cli/paymentReconciliation.ts)
 * installs it, as with the owner spending rules. Every read works without it (no decisions: the rules alone); until
 * it is there a decision is refused with a plain HoldrRefusal that isCardPaymentDecisionsNotInstalled recognizes. A
 * table or index of another shape, or anything else on the table, is a conflict: never repaired, never read.
 *
 * Rows are named by id only (`card-txn-` and `chk-txn-` ids, which never change on re-import): no amount column but
 * the decided amount, no text, no foreign key, so no card or checking table is ever rebuilt around it. A pair's answer
 * (confirmed or rejected) records the days from the payment to the debit (`day_offset`, at most
 * CARD_PAYMENT_RECONCILIATION_RULES.confirmDays either way). A decision is
 * never edited or deleted: undoing it records when and by whom. Partial unique indexes keep at most one decision in
 * force per payment (confirmed or elsewhere), per debit (confirmed or not a card payment) and per rejected pair.
 * Refusals say what was wrong, never what was submitted or stored.
 */
const TABLE_SQL = `CREATE TABLE card_payment_decisions (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'cpd_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected', 'elsewhere', 'not-card-payment')),
  card_transaction_id TEXT CHECK (card_transaction_id IS NULL OR (typeof(card_transaction_id) = 'text' AND length(CAST(card_transaction_id AS BLOB)) = 41 AND substr(card_transaction_id, 1, 9) = 'card-txn-' AND substr(card_transaction_id, 10) NOT GLOB '*[^a-p]*')),
  checking_transaction_id TEXT CHECK (checking_transaction_id IS NULL OR (typeof(checking_transaction_id) = 'text' AND length(CAST(checking_transaction_id AS BLOB)) = 40 AND substr(checking_transaction_id, 1, 8) = 'chk-txn-' AND substr(checking_transaction_id, 9) NOT GLOB '*[^a-p]*')),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor BETWEEN -999999999999 AND -1),
  currency TEXT NOT NULL CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  rules_version INTEGER NOT NULL CHECK (typeof(rules_version) = 'integer' AND rules_version BETWEEN 1 AND 999),
  day_offset INTEGER CHECK (day_offset IS NULL OR (typeof(day_offset) = 'integer' AND day_offset BETWEEN -${CARD_PAYMENT_RECONCILIATION_RULES.confirmDays} AND ${CARD_PAYMENT_RECONCILIATION_RULES.confirmDays})),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  created_by TEXT NOT NULL CHECK (typeof(created_by) = 'text' AND length(CAST(created_by AS BLOB)) = 36 AND substr(created_by, 1, 4) = 'usr_' AND substr(created_by, 5) NOT GLOB '*[^a-p]*'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  revoked_by TEXT CHECK (revoked_by IS NULL OR (typeof(revoked_by) = 'text' AND length(CAST(revoked_by AS BLOB)) = 36 AND substr(revoked_by, 1, 4) = 'usr_' AND substr(revoked_by, 5) NOT GLOB '*[^a-p]*')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK ((card_transaction_id IS NULL) = (decision = 'not-card-payment')),
  CHECK ((checking_transaction_id IS NULL) = (decision = 'elsewhere')),
  CHECK ((day_offset IS NULL) = (decision IN ('elsewhere', 'not-card-payment')))
)`;
const INDEX_SQL = {
  card_payment_decisions_payment: `CREATE UNIQUE INDEX card_payment_decisions_payment ON card_payment_decisions (card_transaction_id)
  WHERE revoked_at IS NULL AND decision IN ('confirmed', 'elsewhere')`,
  card_payment_decisions_debit: `CREATE UNIQUE INDEX card_payment_decisions_debit ON card_payment_decisions (checking_transaction_id)
  WHERE revoked_at IS NULL AND decision IN ('confirmed', 'not-card-payment')`,
  card_payment_decisions_rejected: `CREATE UNIQUE INDEX card_payment_decisions_rejected ON card_payment_decisions (card_transaction_id, checking_transaction_id)
  WHERE revoked_at IS NULL AND decision = 'rejected'`,
} as const;
export const CARD_PAYMENT_DECISIONS_SCHEMA_SQL: readonly string[] = [TABLE_SQL, ...Object.values(INDEX_SQL)];

const TABLE = 'card_payment_decisions';
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
/** Every object on the table, by name: the table, its primary key's own index, and the three unique indexes. */
const EXPECTED_OBJECTS: ReadonlyMap<string, { type: string; sql: string | null }> = new Map([
  [TABLE, { type: 'table', sql: normalizeSql(TABLE_SQL) }],
  [`sqlite_autoindex_${TABLE}_1`, { type: 'index', sql: null }],
  ...Object.entries(INDEX_SQL).map(([name, sql]) => [name, { type: 'index', sql: normalizeSql(sql) }] as const),
]);
export const CARD_PAYMENT_DECISIONS_SCHEMA_DIGEST = digest(CARD_PAYMENT_DECISIONS_SCHEMA_SQL.map(normalizeSql));

const DECISION_ID = /^cpd_[a-p]{32}$/;
const CARD_TRANSACTION_ID = /^card-txn-[a-p]{32}$/;
const CHECKING_TRANSACTION_ID = /^chk-txn-[a-p]{32}$/;
const ACTOR_REF = /^usr_[a-p]{32}$/;
const CURRENCY = /^[A-Z]{3}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_AMOUNT_MINOR = 999_999_999_999;

/** A decision before the operator installed the table: the API's 409. */
export const CARD_PAYMENT_DECISIONS_NOT_INSTALLED = 'card payment decisions are not installed on this Holdr';
/**
 * The table is there in another shape (a missing or extra index, another column, a trigger on it): the API's fixed 409
 * for every reconciliation read and answer, never a read of the rules alone that would ignore the stored answers.
 */
export const CARD_PAYMENT_DECISIONS_CONFLICT = 'card payment decisions on this Holdr are not in the shape this build expects; nothing is matched or answered until the operator resolves it';
export const CARD_PAYMENT_DECISIONS_CONFLICT_CODE = 'card-payment-decisions-conflict';
export const CARD_PAYMENT_DECISION_REFUSALS = Object.freeze({
  conflict: 'card_payment_decisions already exists in another shape; nothing was installed',
  unverified: 'card_payment_decisions did not install as expected; nothing was installed',
  input: 'a card payment decision must be an object',
  decision: `decision must be one of ${CARD_PAYMENT_DECISION_KINDS.join(', ')}`,
  rows: 'confirmed and rejected name a card payment and a checking debit; elsewhere a card payment; not-card-payment a checking debit',
  cardTransactionId: 'cardTransactionId must be a card transaction id',
  checkingTransactionId: 'checkingTransactionId must be a checking transaction id',
  amount: `amountMinor must be a whole negative number of minor units, down to -${MAX_AMOUNT_MINOR}`,
  currency: 'currency must be three capital letters',
  dayOffset: `dayOffset must be the whole days from the payment to the debit, at most ${CARD_PAYMENT_RECONCILIATION_RULES.confirmDays} either way, for a confirmed or rejected pair, and absent otherwise`,
  id: 'id must be a card payment decision id',
  actor: 'a card payment decision needs the acting owner',
  now: 'a card payment decision needs its time as an ISO instant',
  paymentTaken: 'this card payment already has a decision in force; undo it first',
  debitTaken: 'this checking debit already has a decision in force; undo it first',
  pairRejected: 'this pair is already rejected',
  pairConfirmed: 'this pair is confirmed; undo that first',
});

/**
 * Whether `error` is the refusal of a decision without the table. It is a plain HoldrRefusal, sealed by its own
 * constructor, so it passes every value-free boundary unchanged.
 */
export function isCardPaymentDecisionsNotInstalled(error: unknown): boolean {
  try {
    return error instanceof HoldrRefusal && error.message === CARD_PAYMENT_DECISIONS_NOT_INSTALLED;
  } catch {
    return false;
  }
}

/** Whether `error` is a refusal because a row already has a decision in force (the API's 409). */
export function isCardPaymentDecisionTaken(error: unknown): boolean {
  try {
    const { paymentTaken, debitTaken, pairRejected, pairConfirmed } = CARD_PAYMENT_DECISION_REFUSALS;
    const taken: readonly string[] = [paymentTaken, debitTaken, pairRejected, pairConfirmed];
    return error instanceof HoldrRefusal && taken.includes(error.message);
  } catch {
    return false;
  }
}

type Operation =
  | 'read card payment decisions schema'
  | 'install card payment decisions'
  | 'list card payment decisions'
  | 'record card payment decision'
  | 'revoke card payment decision';

export type CardPaymentDecisionsSchemaState = 'present' | 'absent' | 'conflict';

/**
 * Read-only: `present` only for exactly this build's table and indexes, `absent` when nothing has their names and
 * nothing is on the table, `conflict` for anything else (another shape, a missing or extra index, a trigger or view, a
 * name in other letter case).
 */
export function cardPaymentDecisionsSchemaState(db: Database): CardPaymentDecisionsSchemaState {
  try {
    const names = [...EXPECTED_OBJECTS.keys()];
    const objects = db.prepare(`SELECT type, name, sql FROM main.sqlite_master
      WHERE name COLLATE NOCASE IN (${names.map(() => '?').join(', ')}) OR tbl_name = ? COLLATE NOCASE`)
      .all(...names, TABLE) as Array<{ type: unknown; name: unknown; sql: unknown }>;
    if (objects.length === 0) return 'absent';
    const present = objects.length === EXPECTED_OBJECTS.size && objects.every((object) => {
      const expected = typeof object.name === 'string' ? EXPECTED_OBJECTS.get(object.name) : undefined;
      if (!expected || object.type !== expected.type) return false;
      return expected.sql === null ? object.sql === null : typeof object.sql === 'string' && normalizeSql(object.sql) === expected.sql;
    });
    return present ? 'present' : 'conflict';
  } catch (error) {
    throw toValueFreeDbError('read card payment decisions schema', error);
  }
}

/**
 * Only the operator command calls this, inside its backed-up IMMEDIATE transaction (called alone, it runs in one of
 * its own): nothing when the table is there, a refusal for a conflict, else the table and its indexes, verified before
 * it commits.
 */
export function installCardPaymentDecisionsSchema(db: Database): void {
  try {
    db.transaction(() => {
      const state = cardPaymentDecisionsSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.conflict);
      for (const sql of CARD_PAYMENT_DECISIONS_SCHEMA_SQL) db.exec(sql);
      if (cardPaymentDecisionsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.unverified);
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('install card payment decisions', error);
  }
}

/** A stored decision, revoked or in force. */
export interface CardPaymentDecisionRecord extends CardPaymentDecision {
  rulesVersion: number;
  /** For a confirmed or rejected pair: whole days from the payment's transaction date to the debit's date. Else null. */
  dayOffset: number | null;
  revokedAt: string | null;
}

interface DecisionRow {
  id: unknown;
  decision: unknown;
  card_transaction_id: unknown;
  checking_transaction_id: unknown;
  amount_minor: unknown;
  currency: unknown;
  rules_version: unknown;
  day_offset: unknown;
  created_at: unknown;
  revoked_at: unknown;
}
const COLUMNS = 'id, decision, card_transaction_id, checking_transaction_id, amount_minor, currency, rules_version, day_offset, created_at, revoked_at';

const isKind = (value: unknown): value is CardPaymentDecisionKind =>
  typeof value === 'string' && (CARD_PAYMENT_DECISION_KINDS as readonly string[]).includes(value);
const isInstant = (value: unknown): value is string => typeof value === 'string' && INSTANT.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value <= -1 && value >= -MAX_AMOUNT_MINOR;
const optionalId = (value: unknown, pattern: RegExp): value is string | null => value === null || (typeof value === 'string' && pattern.test(value));
const pairKind = (decision: CardPaymentDecisionKind) => decision === 'confirmed' || decision === 'rejected';
/** A pair's day gap for a confirmed or rejected answer (at most confirmDays either way), null for any other. */
const fitsDayOffset = (decision: CardPaymentDecisionKind, value: unknown): value is number | null => (pairKind(decision)
  ? typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= CARD_PAYMENT_RECONCILIATION_RULES.confirmDays
  : value === null);

/** A stored row as the shared decision, or null for one the table's checks should have refused. */
function decisionOf(row: DecisionRow): CardPaymentDecisionRecord | null {
  const { id, decision, card_transaction_id: card, checking_transaction_id: checking, amount_minor: amountMinor,
    currency, rules_version: rulesVersion, day_offset: dayOffset, created_at: createdAt, revoked_at: revokedAt } = row;
  if (typeof id !== 'string' || !DECISION_ID.test(id) || !isKind(decision) || !optionalId(card, CARD_TRANSACTION_ID)
    || !optionalId(checking, CHECKING_TRANSACTION_ID) || !isAmount(amountMinor) || typeof currency !== 'string'
    || !CURRENCY.test(currency) || typeof rulesVersion !== 'number' || !Number.isSafeInteger(rulesVersion)
    || !fitsDayOffset(decision, dayOffset) || !isInstant(createdAt) || (revokedAt !== null && !isInstant(revokedAt))) return null;
  return {
    id, decision, cardTransactionId: card, checkingTransactionId: checking, amountMinor, currency, createdAt,
    rulesVersion, dayOffset, revokedAt,
  };
}

function requireInstalled(db: Database): void {
  if (cardPaymentDecisionsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_PAYMENT_DECISIONS_NOT_INSTALLED);
}

/** Who decides (`usr_` + 32 letters a–p, cardSyncActorRef) and when (a 24-character ISO instant). */
export interface CardPaymentDecisionContext {
  actorRef: string;
  now: string;
}

function changeContext(ctx: unknown): CardPaymentDecisionContext {
  const { actorRef, now } = (typeof ctx === 'object' && ctx !== null ? ctx : {}) as Record<string, unknown>;
  if (typeof actorRef !== 'string' || !ACTOR_REF.test(actorRef)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.actor);
  if (!isInstant(now)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.now);
  return { actorRef, now };
}

/** A decision as the caller checked it against the rows: which rows, their amount and currency now, and a pair's day gap. */
export interface CardPaymentDecisionInput {
  decision: unknown;
  cardTransactionId: unknown;
  checkingTransactionId: unknown;
  amountMinor: unknown;
  currency: unknown;
  /** For a confirmed or rejected pair: whole days from the payment to the debit. Absent or null for any other. */
  dayOffset?: unknown;
}

function decisionInput(input: unknown): {
  decision: CardPaymentDecisionKind; cardTransactionId: string | null; checkingTransactionId: string | null;
  amountMinor: number; currency: string; dayOffset: number | null;
} {
  if (typeof input !== 'object' || input === null) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.input);
  const { decision, cardTransactionId, checkingTransactionId, amountMinor, currency, dayOffset } = input as Record<string, unknown>;
  if (!isKind(decision)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.decision);
  const card = cardTransactionId ?? null;
  const checking = checkingTransactionId ?? null;
  if ((card === null) !== (decision === 'not-card-payment') || (checking === null) !== (decision === 'elsewhere')) {
    throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.rows);
  }
  if (!optionalId(card, CARD_TRANSACTION_ID)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.cardTransactionId);
  if (!optionalId(checking, CHECKING_TRANSACTION_ID)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.checkingTransactionId);
  if (!isAmount(amountMinor)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.amount);
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.currency);
  const gap = dayOffset ?? null;
  if (!fitsDayOffset(decision, gap)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.dayOffset);
  return { decision, cardTransactionId: card, checkingTransactionId: checking, amountMinor, currency, dayOffset: gap };
}

/** Decisions oldest first: those in force, or every one with `includeRevoked`. None unless the table is exactly this build's. */
export function listCardPaymentDecisions(db: Database, options: { includeRevoked?: boolean } = {}): CardPaymentDecisionRecord[] {
  try {
    return db.transaction((): CardPaymentDecisionRecord[] => {
      if (cardPaymentDecisionsSchemaState(db) !== 'present') return [];
      const rows = db.prepare(`SELECT ${COLUMNS} FROM main.card_payment_decisions
        ${options.includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY created_at, id`)
        .safeIntegers(false).all() as DecisionRow[];
      return rows.flatMap((row) => decisionOf(row) ?? []);
    })();
  } catch (error) {
    throw toValueFreeDbError('list card payment decisions', error);
  }
}

/**
 * A new decision in force from `now`. The caller has checked its rows (they exist, fit the decision and have this
 * amount and currency); this checks that no decision in force already takes them, under the write lock, then writes.
 */
export function recordCardPaymentDecision(db: Database, input: CardPaymentDecisionInput, ctx: CardPaymentDecisionContext): CardPaymentDecisionRecord {
  try {
    // Without the table, refused before the write lock is even asked for; checked again under it.
    requireInstalled(db);
    return db.transaction((): CardPaymentDecisionRecord => {
      requireInstalled(db);
      const fields = decisionInput(input);
      const { actorRef, now } = changeContext(ctx);
      const inForce = (sql: string, ...params: unknown[]) =>
        db.prepare(`SELECT 1 FROM main.card_payment_decisions WHERE revoked_at IS NULL AND ${sql}`).get(...params) !== undefined;
      const { cardTransactionId: card, checkingTransactionId: checking } = fields;
      if (fields.decision === 'confirmed' || fields.decision === 'elsewhere') {
        if (inForce("decision IN ('confirmed', 'elsewhere') AND card_transaction_id = ?", card)) {
          throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.paymentTaken);
        }
      }
      if (fields.decision === 'confirmed' || fields.decision === 'not-card-payment') {
        if (inForce("decision IN ('confirmed', 'not-card-payment') AND checking_transaction_id = ?", checking)) {
          throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.debitTaken);
        }
      }
      if (fields.decision === 'confirmed' && inForce("decision = 'rejected' AND card_transaction_id = ? AND checking_transaction_id = ?", card, checking)) {
        throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.pairRejected);
      }
      if (fields.decision === 'rejected') {
        if (inForce("decision = 'rejected' AND card_transaction_id = ? AND checking_transaction_id = ?", card, checking)) {
          throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.pairRejected);
        }
        if (inForce("decision = 'confirmed' AND card_transaction_id = ? AND checking_transaction_id = ?", card, checking)) {
          throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.pairConfirmed);
        }
      }
      const record: CardPaymentDecisionRecord = {
        id: `cpd_${randomCardSyncLetters()}`, ...fields, createdAt: now,
        rulesVersion: CARD_PAYMENT_RECONCILIATION_RULES.version, revokedAt: null,
      };
      db.prepare(`INSERT INTO main.card_payment_decisions
        (id, decision, card_transaction_id, checking_transaction_id, amount_minor, currency, rules_version, day_offset, created_at,
         created_by, revoked_at, revoked_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(record.id, record.decision, card, checking, record.amountMinor, record.currency, record.rulesVersion, record.dayOffset,
          now, actorRef);
      return record;
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('record card payment decision', error);
  }
}

/** Undoes a decision at `now` (kept, with who undid it). An already undone decision comes back unchanged; an unknown id, null. */
export function revokeCardPaymentDecision(db: Database, id: unknown, ctx: CardPaymentDecisionContext): CardPaymentDecisionRecord | null {
  try {
    requireInstalled(db);
    return db.transaction((): CardPaymentDecisionRecord | null => {
      requireInstalled(db);
      if (typeof id !== 'string' || !DECISION_ID.test(id)) throw new HoldrRefusal(CARD_PAYMENT_DECISION_REFUSALS.id);
      const { actorRef, now } = changeContext(ctx);
      const row = db.prepare(`SELECT ${COLUMNS} FROM main.card_payment_decisions WHERE id = ?`).safeIntegers(false).get(id) as DecisionRow | undefined;
      const record = row === undefined ? null : decisionOf(row);
      if (record === null || record.revokedAt !== null) return record;
      db.prepare('UPDATE main.card_payment_decisions SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now, actorRef, id);
      return { ...record, revokedAt: now };
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('revoke card payment decision', error);
  }
}
