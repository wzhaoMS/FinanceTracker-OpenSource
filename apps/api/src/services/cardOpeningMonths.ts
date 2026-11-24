import type { Database } from 'better-sqlite3';
import type { CardOpeningConfirmation } from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import { randomCardSyncLetters } from './cardSyncDigests.js';
import { HoldrRefusal, toValueFreeDbError } from './dbErrors.js';

/**
 * The owner's card opening months ("this card was opened in <month>", shared cardOpeningMonths.ts), in the one table
 * `card_opening_months`: at most one month in force per card account, and every change and clear kept (a change ends
 * the month in force and adds the new one; a clear only ends it). Nothing creates the table at boot: only the
 * backed-up, Root-GO-gated operator command (cli/cardOpenings.ts) installs it. Every read works without it (no months);
 * until it is there, writes refuse with a plain HoldrRefusal that isCardOpeningMonthsNotInstalled recognizes. A table
 * of another shape, or any other object of that name, is a conflict: never repaired, never read. Refusals say what was
 * wrong, never what was submitted or stored.
 */
export const CARD_OPENING_MONTHS_SCHEMA_SQL = `CREATE TABLE card_opening_months (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'com_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id TEXT NOT NULL CHECK (typeof(card_account_id) = 'text' AND length(CAST(card_account_id AS BLOB)) BETWEEN 1 AND 64 AND length(card_account_id) = length(CAST(card_account_id AS BLOB)) AND card_account_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  opening_month TEXT NOT NULL CHECK (typeof(opening_month) = 'text' AND length(CAST(opening_month AS BLOB)) = 7 AND opening_month GLOB '[12][0-9][0-9][0-9]-[01][0-9]' AND opening_month BETWEEN '1900-01' AND '2099-12' AND substr(opening_month, 6, 2) BETWEEN '01' AND '12'),
  confirmed_at TEXT NOT NULL CHECK (typeof(confirmed_at) = 'text' AND length(CAST(confirmed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS confirmed_at),
  confirmed_by TEXT NOT NULL CHECK (typeof(confirmed_by) = 'text' AND length(CAST(confirmed_by AS BLOB)) = 36 AND substr(confirmed_by, 1, 4) = 'usr_' AND substr(confirmed_by, 5) NOT GLOB '*[^a-p]*'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  revoked_by TEXT CHECK (revoked_by IS NULL OR (typeof(revoked_by) = 'text' AND length(CAST(revoked_by AS BLOB)) = 36 AND substr(revoked_by, 1, 4) = 'usr_' AND substr(revoked_by, 5) NOT GLOB '*[^a-p]*')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
)`;
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const EXPECTED_SQL = normalizeSql(CARD_OPENING_MONTHS_SCHEMA_SQL);
export const CARD_OPENING_MONTHS_SCHEMA_DIGEST = digest(EXPECTED_SQL);

/** A batch confirms at most this many cards. */
export const MAX_CARD_OPENING_MONTHS = 200;
const RECORD_ID = /^com_[a-p]{32}$/;
const CARD_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 1900-01 through 2099-12, as the table checks it. */
const OPENING_MONTH = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/;
const ACTOR_REF = /^usr_[a-p]{32}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A write before the operator installed the table, or while another object holds its name: the API's 409. */
export const CARD_OPENING_MONTHS_NOT_INSTALLED = 'card opening months are not installed on this Holdr';
export const CARD_OPENING_MONTHS_REFUSED = Object.freeze({
  conflict: 'card_opening_months already exists in another shape; nothing was installed',
  unverified: 'card_opening_months did not install as expected; nothing was installed',
  input: `card opening months must be a list of 1 to ${MAX_CARD_OPENING_MONTHS} cards, each with its opening month`,
  card: 'cardAccountId must be a card account on this Holdr',
  duplicate: 'each card may be confirmed once in a change',
  month: 'openingMonth must be a month from 1900-01, as YYYY-MM',
  future: 'openingMonth must not be after this month',
  contradicted: 'openingMonth must not be after the month of the first day Holdr has for the card',
  actor: 'an opening month change needs the acting owner',
  now: 'an opening month change needs its time as an ISO instant',
});
const REFUSED = CARD_OPENING_MONTHS_REFUSED;

/**
 * Whether `error` is the refusal of a write without the table. It is a plain HoldrRefusal, sealed by its own
 * constructor, so it passes every value-free boundary unchanged (the repository's withValueFreeDbErrors included).
 */
export function isCardOpeningMonthsNotInstalled(error: unknown): boolean {
  try {
    return error instanceof HoldrRefusal && error.message === CARD_OPENING_MONTHS_NOT_INSTALLED;
  } catch {
    return false;
  }
}

type Operation =
  | 'read card opening months schema'
  | 'install card opening months'
  | 'list card opening months'
  | 'confirm card opening months'
  | 'clear card opening month';
/** Holdr's own untouched refusals leave unchanged; anything else as a HoldrDbError naming only the operation and code. */
function valueFree(operation: Operation, error: unknown): Error {
  return toValueFreeDbError(operation, error);
}

export type CardOpeningMonthsSchemaState = 'present' | 'absent' | 'conflict';

/**
 * Read-only: `present` only for exactly this build's table, `absent` when nothing has its name, `conflict` for
 * anything else with that name (another shape, an index, a view, a trigger, the name in other letter case).
 */
export function cardOpeningMonthsSchemaState(db: Database): CardOpeningMonthsSchemaState {
  try {
    const objects = db.prepare("SELECT type, sql FROM main.sqlite_master WHERE name = 'card_opening_months' COLLATE NOCASE")
      .all() as Array<{ type: unknown; sql: unknown }>;
    if (objects.length === 0) return 'absent';
    const [object] = objects;
    return objects.length === 1 && object.type === 'table' && typeof object.sql === 'string'
      && normalizeSql(object.sql) === EXPECTED_SQL ? 'present' : 'conflict';
  } catch (error) {
    throw valueFree('read card opening months schema', error);
  }
}

export function hasCardOpeningMonthsSchema(db: Database): boolean {
  return cardOpeningMonthsSchemaState(db) === 'present';
}

/**
 * Only the operator command calls this, inside its backed-up IMMEDIATE transaction (called alone, it runs in one of
 * its own): nothing when the table is there, a refusal for a conflict, else the table, verified before it commits.
 */
export function installCardOpeningMonthsSchema(db: Database): void {
  try {
    db.transaction(() => {
      const state = cardOpeningMonthsSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal(REFUSED.conflict);
      db.exec(CARD_OPENING_MONTHS_SCHEMA_SQL);
      if (cardOpeningMonthsSchemaState(db) !== 'present') throw new HoldrRefusal(REFUSED.unverified);
    }).immediate();
  } catch (error) {
    throw valueFree('install card opening months', error);
  }
}

/** One stored confirmation, without who made or ended it. */
export interface CardOpeningMonthRecord extends CardOpeningConfirmation {
  id: string;
  cardAccountId: string;
}

interface RecordRow {
  id: unknown;
  card_account_id: unknown;
  opening_month: unknown;
  confirmed_at: unknown;
  revoked_at: unknown;
}
const RECORD_COLUMNS = 'id, card_account_id, opening_month, confirmed_at, revoked_at';

const isInstant = (value: unknown): value is string => typeof value === 'string' && INSTANT.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** A stored row as a record (no actor refs), or null for one the table's checks should have refused. */
function recordOf(row: RecordRow): CardOpeningMonthRecord | null {
  const { id, card_account_id: cardAccountId, opening_month: openingMonth, confirmed_at: confirmedAt, revoked_at: revokedAt } = row;
  if (typeof id !== 'string' || !RECORD_ID.test(id) || typeof cardAccountId !== 'string' || !CARD_ACCOUNT_ID.test(cardAccountId)
    || typeof openingMonth !== 'string' || !OPENING_MONTH.test(openingMonth) || !isInstant(confirmedAt)
    || (revokedAt !== null && !isInstant(revokedAt))) return null;
  return { id, cardAccountId, openingMonth, confirmedAt, revokedAt };
}

function requireInstalled(db: Database): void {
  if (cardOpeningMonthsSchemaState(db) !== 'present') throw new HoldrRefusal(CARD_OPENING_MONTHS_NOT_INSTALLED);
}

/** Who changes a month (`usr_` + 32 letters a–p, cardSyncActorRef) and when (a 24-character ISO instant). */
export interface CardOpeningMonthContext {
  actorRef: string;
  now: string;
}

function changeContext(ctx: unknown): CardOpeningMonthContext {
  const { actorRef, now } = (typeof ctx === 'object' && ctx !== null ? ctx : {}) as Record<string, unknown>;
  if (typeof actorRef !== 'string' || !ACTOR_REF.test(actorRef)) throw new HoldrRefusal(REFUSED.actor);
  if (!isInstant(now)) throw new HoldrRefusal(REFUSED.now);
  return { actorRef, now };
}

/** Every confirmation, ended ones included, in the order they were made. None unless the table is exactly this build's. */
export function listCardOpeningMonths(db: Database): CardOpeningMonthRecord[] {
  try {
    return db.transaction((): CardOpeningMonthRecord[] => {
      if (cardOpeningMonthsSchemaState(db) !== 'present') return [];
      // Rows are never deleted, so rowid order is the order they were written, within one instant too.
      const rows = db.prepare(`SELECT ${RECORD_COLUMNS} FROM main.card_opening_months ORDER BY confirmed_at, rowid`)
        .safeIntegers(false).all() as RecordRow[];
      return rows.flatMap((row) => recordOf(row) ?? []);
    })();
  } catch (error) {
    throw valueFree('list card opening months', error);
  }
}

/**
 * The month in force per card account, from `records`: a card with more than one in force (never written by this
 * store) has none, so coverage takes it as without a month.
 */
export function cardOpeningMonthsInForce(records: readonly CardOpeningMonthRecord[]): Map<string, string> {
  const inForce = new Map<string, string | null>();
  for (const record of records) {
    if (record.revokedAt !== null) continue;
    inForce.set(record.cardAccountId, inForce.has(record.cardAccountId) ? null : record.openingMonth);
  }
  return new Map([...inForce].flatMap(([cardAccountId, month]) => (month === null ? [] : [[cardAccountId, month] as const])));
}

export interface CardOpeningMonthInput {
  cardAccountId: unknown;
  openingMonth: unknown;
}

/** The cards and months of a change, each card once, in the order given. */
function changeInput(input: unknown): Array<{ cardAccountId: string; openingMonth: string }> {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CARD_OPENING_MONTHS) throw new HoldrRefusal(REFUSED.input);
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new HoldrRefusal(REFUSED.input);
    const { cardAccountId, openingMonth } = entry as Record<string, unknown>;
    if (typeof cardAccountId !== 'string' || !CARD_ACCOUNT_ID.test(cardAccountId)) throw new HoldrRefusal(REFUSED.card);
    if (seen.has(cardAccountId)) throw new HoldrRefusal(REFUSED.duplicate);
    seen.add(cardAccountId);
    if (typeof openingMonth !== 'string' || !OPENING_MONTH.test(openingMonth)) throw new HoldrRefusal(REFUSED.month);
    return { cardAccountId, openingMonth };
  });
}

const cardExists = (db: Database, cardAccountId: string) =>
  db.prepare('SELECT 1 FROM main.card_accounts WHERE id = ?').get(cardAccountId) !== undefined;

/**
 * Each card's first known day by the read path's one definition (shared cardOpeningEvidence over the evidence coverage
 * reads: the first non-removed row, the dates its imports declared, and sync windows Holdr verified complete); null for
 * a card with none. The store calls it inside its write transaction, under the write lock, on the same connection.
 */
export type CardFirstKnownDays = (cardAccountIds: readonly string[]) => ReadonlyMap<string, string | null>;

/**
 * Confirms each card's opening month from `now`, all or nothing, in one IMMEDIATE transaction. A card whose month in
 * force is already that month is left as it is; any other month in force is ended (kept, with when and by whom) and the
 * new one added. Refused, writing nothing: a card that is not on this Holdr, a month after `now`'s, or a month later
 * than the month of the card's first known day, read by `firstKnownDays` inside this transaction: evidence already
 * exists earlier (Root's consistency guard). An earlier month is taken.
 */
export function confirmCardOpeningMonths(
  db: Database,
  input: unknown,
  ctx: CardOpeningMonthContext,
  firstKnownDays: CardFirstKnownDays,
): { changed: number; unchanged: number } {
  try {
    // Without the table, refused before the write lock is even asked for; checked again under it.
    requireInstalled(db);
    return db.transaction((): { changed: number; unchanged: number } => {
      requireInstalled(db);
      const entries = changeInput(input);
      const { actorRef, now } = changeContext(ctx);
      for (const { cardAccountId, openingMonth } of entries) {
        if (!cardExists(db, cardAccountId)) throw new HoldrRefusal(REFUSED.card);
        if (openingMonth > now.slice(0, 7)) throw new HoldrRefusal(REFUSED.future);
      }
      // One definition of the first known day, read here under the write lock: what coverage reads, nothing else.
      const firstKnown = firstKnownDays(entries.map((entry) => entry.cardAccountId));
      for (const { cardAccountId, openingMonth } of entries) {
        const day = firstKnown.get(cardAccountId);
        if (typeof day === 'string' && DAY.test(day) && day < `${openingMonth}-01`) throw new HoldrRefusal(REFUSED.contradicted);
      }
      const inForce = db.prepare('SELECT opening_month FROM main.card_opening_months WHERE card_account_id = ? AND revoked_at IS NULL').pluck();
      const end = db.prepare('UPDATE main.card_opening_months SET revoked_at = ?, revoked_by = ? WHERE card_account_id = ? AND revoked_at IS NULL');
      const add = db.prepare(`INSERT INTO main.card_opening_months
        (id, card_account_id, opening_month, confirmed_at, confirmed_by, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, NULL, NULL)`);
      let changed = 0;
      for (const { cardAccountId, openingMonth } of entries) {
        const months = inForce.all(cardAccountId) as unknown[];
        if (months.length === 1 && months[0] === openingMonth) continue;
        end.run(now, actorRef, cardAccountId);
        add.run(`com_${randomCardSyncLetters()}`, cardAccountId, openingMonth, now, actorRef);
        changed += 1;
      }
      return { changed, unchanged: entries.length - changed };
    }).immediate();
  } catch (error) {
    throw valueFree('confirm card opening months', error);
  }
}

/**
 * Ends the card's month in force at `now` (kept, with who ended it): true when one was ended, false when none was in
 * force, null for a card that is not on this Holdr.
 */
export function clearCardOpeningMonth(db: Database, cardAccountId: unknown, ctx: CardOpeningMonthContext): boolean | null {
  try {
    requireInstalled(db);
    return db.transaction((): boolean | null => {
      requireInstalled(db);
      if (typeof cardAccountId !== 'string' || !CARD_ACCOUNT_ID.test(cardAccountId)) throw new HoldrRefusal(REFUSED.card);
      const { actorRef, now } = changeContext(ctx);
      if (!cardExists(db, cardAccountId)) return null;
      return db.prepare('UPDATE main.card_opening_months SET revoked_at = ?, revoked_by = ? WHERE card_account_id = ? AND revoked_at IS NULL')
        .run(now, actorRef, cardAccountId).changes > 0;
    }).immediate();
  } catch (error) {
    throw valueFree('clear card opening month', error);
  }
}
