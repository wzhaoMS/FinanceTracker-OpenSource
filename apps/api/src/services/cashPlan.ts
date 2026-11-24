import type { Database } from 'better-sqlite3';
import {
  CASH_PLAN_RULES,
  CASH_PLAN_TIME_ZONE,
  cardNicknameKey,
  cardSchedulePayloadDigest,
  cashPlanForCard,
  easternDate,
  mergeCardCoverage,
  observationAsOf,
  reconcileCardPayments,
  type CardCoverageRange,
  type CardPlan,
  type CardScheduleHeldReason,
  type CardScheduleObservation,
  type CashPlanAttentionItem,
  type CashPlanBankRead,
  type CashPlanCardRow,
  type CashPlanCycle,
  type CashPlanDelinquency,
  type CashPlanRules,
  type ReconciliationCardRow,
  type ReconciliationCheckingRow,
  type ValidCardScheduleObservation,
} from '@finance-tracker/shared';

import { digest } from './amazon/policy.js';
import { CARD_PAYMENT_DECISIONS_CONFLICT, cardPaymentDecisionsSchemaState, listCardPaymentDecisions } from './cardPaymentDecisions.js';
import { randomCardSyncLetters } from './cardSyncDigests.js';
import { HoldrRefusal, toValueFreeDbError } from './dbErrors.js';

/** The checking ledger's read-only reader, as the payment reconciliation reads it (createApp passes it in). */
export interface CashPlanCheckingReader {
  installed(): boolean;
  listAccounts(): Array<{ id: string; last4?: string | null }>;
  listRows(range: { from: string; to: string }): ReconciliationCheckingRow[];
  coverage(): Array<{ checkingAccountId: string; ranges: Array<{ start: string; end: string }> }>;
}

/**
 * The card payment schedule's declared schema delta and its reads (A1 spec v9 §2, §4, §5). The table
 * `card_schedule_observations` is created only by the backed-up, Root-GO-gated operator command (`holdr-cash install`);
 * the API never creates it, and without it every read answers `installed: false`. Rows are appended by `holdr-cash
 * import` only and never updated. Another object with its names, or anything else on the table, is a conflict: never
 * repaired, never read.
 */

const TABLE = 'card_schedule_observations';
const INDEX = 'card_schedule_observations_card_cycle';
const DATE = (column: string) => `(${column} IS NULL OR (typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 10 AND date(${column}) IS ${column}))`;
const MINOR = (column: string, rule = '') => `(${column} IS NULL OR (typeof(${column}) = 'integer' AND ${column} BETWEEN -999999999999 AND 999999999999${rule}))`;
const INSTANT = (column: string) => `(typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column})`;
const TABLE_SQL = `CREATE TABLE card_schedule_observations (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'cso-' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id TEXT NULL REFERENCES card_accounts(id),
  issuer TEXT NOT NULL CHECK (typeof(issuer) = 'text' AND length(issuer) BETWEEN 1 AND 32),
  currency TEXT NOT NULL CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('issuer-dashboard-dom', 'issuer-dashboard-json', 'statement-pdf', 'owner-entry')),
  source_ref TEXT NOT NULL CHECK (typeof(source_ref) = 'text' AND length(source_ref) BETWEEN 1 AND 200),
  observed_at TEXT NOT NULL CHECK ${INSTANT('observed_at')},
  financial_as_of TEXT NOT NULL,
  as_of_source TEXT NOT NULL CHECK (as_of_source IN ('explicit', 'statement', 'implicit-capture')),
  as_of_precision TEXT NOT NULL CHECK (as_of_precision IN ('instant', 'date')),
  import_ref TEXT NOT NULL CHECK (typeof(import_ref) = 'text' AND length(import_ref) BETWEEN 1 AND 200),
  payload_digest TEXT NOT NULL CHECK (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  extractor_version TEXT NOT NULL CHECK (typeof(extractor_version) = 'text' AND length(extractor_version) BETWEEN 1 AND 64),
  statement_period_start_date TEXT NULL CHECK ${DATE('statement_period_start_date')},
  statement_closing_date TEXT NULL CHECK ${DATE('statement_closing_date')},
  payment_due_date TEXT NULL CHECK ${DATE('payment_due_date')},
  statement_balance_minor INTEGER NULL CHECK ${MINOR('statement_balance_minor')},
  minimum_due_minor INTEGER NULL CHECK ${MINOR('minimum_due_minor', ' AND minimum_due_minor >= 0')},
  minimum_basis TEXT NULL CHECK (minimum_basis IN ('total-due')),
  remaining_statement_minor INTEGER NULL CHECK ${MINOR('remaining_statement_minor')},
  current_balance_minor INTEGER NULL CHECK ${MINOR('current_balance_minor')},
  past_due_minor INTEGER NULL CHECK ${MINOR('past_due_minor', ' AND past_due_minor >= 0')},
  last_payment_date TEXT NULL CHECK ${DATE('last_payment_date')},
  last_payment_minor INTEGER NULL CHECK ${MINOR('last_payment_minor', ' AND last_payment_minor > 0')},
  scheduled_payment_date TEXT NULL CHECK ${DATE('scheduled_payment_date')},
  scheduled_payment_minor INTEGER NULL CHECK ${MINOR('scheduled_payment_minor', ' AND scheduled_payment_minor > 0')},
  autopay TEXT NULL CHECK (autopay IN ('on-statement', 'on-minimum', 'on-fixed', 'on-other', 'off', 'not-shown')),
  autopay_fixed_minor INTEGER NULL CHECK ${MINOR('autopay_fixed_minor', " AND autopay_fixed_minor > 0 AND autopay IS 'on-fixed'")},
  issuer_phrase TEXT NULL CHECK (issuer_phrase IN ('not-required', 'paid', 'past-due', 'none')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'held')),
  held_reason TEXT NULL CHECK (held_reason IN ('unbound', 'ambiguous-card', 'invalid', 'dom-json-disagree', 'cycle-unknown', 'minimum-basis')),
  imported_at TEXT NOT NULL CHECK ${INSTANT('imported_at')},
  CHECK ((status = 'held') = (held_reason IS NOT NULL)),
  CHECK (status = 'held' OR card_account_id IS NOT NULL),
  CHECK (statement_closing_date IS NULL OR payment_due_date IS NULL OR statement_closing_date <= payment_due_date),
  CHECK ((minimum_due_minor IS NULL) = (minimum_basis IS NULL)),
  CHECK (statement_period_start_date IS NULL OR (statement_closing_date IS NOT NULL AND statement_period_start_date < statement_closing_date)),
  CHECK ((as_of_precision = 'date' AND typeof(financial_as_of) = 'text' AND length(CAST(financial_as_of AS BLOB)) = 10 AND date(financial_as_of) IS financial_as_of)
    OR (as_of_precision = 'instant' AND ${INSTANT('financial_as_of')})),
  CHECK (source_kind <> 'statement-pdf' OR (statement_closing_date IS NOT NULL AND as_of_source = 'statement'
    AND as_of_precision = 'date' AND financial_as_of = statement_closing_date)),
  CHECK (as_of_source <> 'statement' OR source_kind = 'statement-pdf'),
  UNIQUE (card_account_id, payload_digest)
)`;
const INDEX_SQL = `CREATE INDEX card_schedule_observations_card_cycle ON card_schedule_observations(card_account_id, statement_closing_date, payment_due_date)`;
/** The declared schema delta, statement by statement: the table, then its index. */
export const CASH_PLAN_SCHEMA_SQL: readonly string[] = Object.freeze([TABLE_SQL, INDEX_SQL]);
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
/** Every object on the table, by name: the table, its primary key's and unique constraint's own indexes, and its index. */
const EXPECTED_OBJECTS: ReadonlyMap<string, { type: string; sql: string | null }> = new Map([
  [TABLE, { type: 'table', sql: normalizeSql(TABLE_SQL) }],
  [`sqlite_autoindex_${TABLE}_1`, { type: 'index', sql: null }],
  [`sqlite_autoindex_${TABLE}_2`, { type: 'index', sql: null }],
  [INDEX, { type: 'index', sql: normalizeSql(INDEX_SQL) }],
]);
export const CASH_PLAN_SCHEMA_DIGEST = digest(CASH_PLAN_SCHEMA_SQL.map(normalizeSql));

export const CASH_PLAN_REFUSALS = Object.freeze({
  conflict: 'card_schedule_observations already exists in another shape; nothing was installed',
  unverified: 'card_schedule_observations did not install as expected; nothing was installed',
  notInstalled: 'card schedule observations are not installed on this Holdr',
});
/** The table in another shape: the API's fixed 409; nothing is read until the operator resolves it. */
export const CASH_PLAN_CONFLICT = 'card schedule observations on this Holdr are not in the shape this build expects; nothing is read until the operator resolves it';

export type CashPlanSchemaState = 'present' | 'absent' | 'conflict';

/**
 * Read-only: `present` only for exactly this build's table and indexes, `absent` when nothing has their names and nothing
 * is on the table, `conflict` for anything else (another shape, a missing or extra index, a trigger or view, a name in
 * other letter case).
 */
export function cashPlanSchemaState(db: Database): CashPlanSchemaState {
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
    throw toValueFreeDbError('read cash plan schema', error);
  }
}

/**
 * Only the operator command calls this, inside its backed-up IMMEDIATE transaction (called alone, it runs in one of its
 * own): nothing when the table is there, a refusal for a conflict, else the table and its index, verified before commit.
 */
export function installCashPlanSchema(db: Database): void {
  try {
    db.transaction(() => {
      const state = cashPlanSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal(CASH_PLAN_REFUSALS.conflict);
      for (const sql of CASH_PLAN_SCHEMA_SQL) db.exec(sql);
      if (cashPlanSchemaState(db) !== 'present') throw new HoldrRefusal(CASH_PLAN_REFUSALS.unverified);
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('install cash plan', error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads (one reader for the API route and the operator report)
// ---------------------------------------------------------------------------------------------------------------------

interface ObservationRow {
  id: string; card_account_id: string | null; issuer: string; currency: string; source_kind: CardScheduleObservation['sourceKind'];
  source_ref: string; observed_at: string; financial_as_of: string; as_of_source: CardScheduleObservation['asOfSource'];
  as_of_precision: CardScheduleObservation['asOfPrecision']; import_ref: string; payload_digest: string; extractor_version: string;
  statement_period_start_date: string | null; statement_closing_date: string | null; payment_due_date: string | null;
  statement_balance_minor: number | null; minimum_due_minor: number | null; minimum_basis: 'total-due' | null;
  remaining_statement_minor: number | null; current_balance_minor: number | null; past_due_minor: number | null;
  last_payment_date: string | null; last_payment_minor: number | null; scheduled_payment_date: string | null;
  scheduled_payment_minor: number | null; autopay: CardScheduleObservation['autopay']; autopay_fixed_minor: number | null;
  issuer_phrase: CardScheduleObservation['issuerPhrase']; status: 'accepted' | 'held'; held_reason: CardScheduleHeldReason | null;
  imported_at: string;
}

/** Every stored observation, accepted and held. The table must be present. */
export function listCardScheduleObservations(db: Database): CardScheduleObservation[] {
  const rows = db.prepare(`SELECT * FROM ${TABLE} ORDER BY id`).all() as ObservationRow[];
  return rows.map((row) => ({
    id: row.id, cardAccountId: row.card_account_id, issuer: row.issuer, currency: row.currency, sourceKind: row.source_kind,
    sourceRef: row.source_ref, observedAt: row.observed_at, financialAsOf: row.financial_as_of, asOfSource: row.as_of_source,
    asOfPrecision: row.as_of_precision, importRef: row.import_ref, payloadDigest: row.payload_digest, extractorVersion: row.extractor_version,
    statementPeriodStartDate: row.statement_period_start_date, statementClosingDate: row.statement_closing_date,
    paymentDueDate: row.payment_due_date, statementBalanceMinor: row.statement_balance_minor, minimumDueMinor: row.minimum_due_minor,
    minimumBasis: row.minimum_basis, remainingStatementMinor: row.remaining_statement_minor, currentBalanceMinor: row.current_balance_minor,
    pastDueMinor: row.past_due_minor, lastPaymentDate: row.last_payment_date, lastPaymentMinor: row.last_payment_minor,
    scheduledPaymentDate: row.scheduled_payment_date, scheduledPaymentMinor: row.scheduled_payment_minor, autopay: row.autopay,
    autopayFixedMinor: row.autopay_fixed_minor, issuerPhrase: row.issuer_phrase, status: row.status, heldReason: row.held_reason,
    importedAt: row.imported_at,
  }));
}

interface CashPlanAccount {
  id: string;
  issuer: string;
  owner: string;
  nickname: string | null;
  last4: string | null;
  last5: string | null;
  currency: string;
  status: 'active' | 'closed';
}

const ALL_DAYS = { from: '1900-01-01', to: '9999-12-31' } as const;

/**
 * Committed card coverage, as the card routes read it (routes/cardSpendingOverview.ts `cardCoverageEvidence`): the date
 * ranges each card's imports declared, and card-sync windows Holdr verified complete over the days a transaction-date read
 * asked for. Read raw, so the operator report reads exactly what the API reads.
 */
export function cashPlanCardCoverage(db: Database): Map<string, CardCoverageRange[]> {
  const coverage = new Map<string, CardCoverageRange[]>();
  const add = (cardAccountId: string, range: CardCoverageRange) => {
    const list = coverage.get(cardAccountId);
    if (list) list.push(range);
    else coverage.set(cardAccountId, [range]);
  };
  for (const batch of db.prepare(`SELECT card_account_id AS id, coverage_start AS start, coverage_end AS "end" FROM card_import_batches
      WHERE coverage_start IS NOT NULL AND coverage_end IS NOT NULL ORDER BY imported_at, rowid`).all() as Array<{ id: string; start: string; end: string }>) {
    add(batch.id, { start: batch.start, end: batch.end });
  }
  const windows = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'card_coverage_windows'`).get() !== undefined;
  if (windows) {
    for (const window of db.prepare(`SELECT card_account_id AS id, requested_start AS start, requested_end AS "end" FROM card_coverage_windows
        WHERE ledger_state = 'committed' AND verified_completeness = 'complete' AND requested_start IS NOT NULL
          AND requested_end IS NOT NULL AND requested_basis = 'transaction' ORDER BY recorded_at, id`).all() as Array<{ id: string; start: string; end: string }>) {
      add(window.id, { start: window.start, end: window.end });
    }
  }
  for (const [id, ranges] of coverage) coverage.set(id, mergeCardCoverage(ranges));
  return coverage;
}

interface CashPlanInputs {
  installed: boolean;
  accounts: CashPlanAccount[];
  observations: CardScheduleObservation[];
  rows: CashPlanCardRow[];
  coverage: Map<string, CardCoverageRange[]>;
  returned: Set<string>;
  uncertain: Set<string>;
  /** Per returned or possibly reversed payment row: the date of its latest possible reversal (#269 finding 3). */
  reversalDates: Map<string, string>;
}

/**
 * What the engine reads, raw and read-only: card accounts, observations, every credit row on every card (removals and
 * merges included, with when each was removed), committed coverage, and the payment reconciliation's card returns and
 * possible reversals with their dates (as the Payments page reads them: checking rows, the owner's decisions in force and
 * both sides' coverage). A decisions table in another shape is the reconciliation's fixed 409, before anything is read.
 * Without the observations table nothing else is read.
 */
export function readCashPlanInputs(db: Database, checking: CashPlanCheckingReader | null): CashPlanInputs {
  const state = cashPlanSchemaState(db);
  if (state === 'conflict') throw new HoldrRefusal(CASH_PLAN_CONFLICT);
  const empty: CashPlanInputs = {
    installed: false, accounts: [], observations: [], rows: [], coverage: new Map(), returned: new Set(), uncertain: new Set(), reversalDates: new Map(),
  };
  if (state === 'absent') return empty;
  const decisionsState = cardPaymentDecisionsSchemaState(db);
  if (decisionsState === 'conflict') throw new HoldrRefusal(CARD_PAYMENT_DECISIONS_CONFLICT);
  const accounts = db.prepare(`SELECT id, issuer, owner, nickname, last4, last5, currency, status FROM card_accounts ORDER BY created_at, rowid`).all() as CashPlanAccount[];
  const observations = listCardScheduleObservations(db);
  const rows = (db.prepare(`SELECT id, card_account_id AS cardAccountId, source, transaction_date AS transactionDate, posted_date AS postedDate,
      status, amount_minor AS amountMinor, currency, kind, description, merchant, issuer_category AS issuerCategory, created_at AS createdAt,
      merged_into_id AS mergedIntoId, removed_reason AS removedReason, removed_from_status AS removedFromStatus, removed_at AS removedAt
    FROM card_transactions WHERE amount_minor < 0 ORDER BY id`).all()) as CashPlanCardRow[];
  const coverage = cashPlanCardCoverage(db);
  // The payment reconciliation, read as the Payments page reads it, for card returns and unresolved possible reversals.
  const paymentRows = (db.prepare(`SELECT id, card_account_id AS cardAccountId, transaction_date AS transactionDate, posted_date AS postedDate,
      status, amount_minor AS amountMinor, currency, kind, description, merchant, issuer_category AS issuerCategory
    FROM card_transactions WHERE status IN ('pending', 'posted') AND kind IN ('payment') ORDER BY transaction_date, rowid`).all() as Array<Record<string, unknown>>)
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? undefined : value])) as unknown as ReconciliationCardRow);
  const reader = checking !== null && checking.installed() === true ? checking : null;
  const reconciliation = reconcileCardPayments({
    cardAccounts: accounts.map((account) => ({ id: account.id, issuer: account.issuer, last4: account.last4, last5: account.last5 })),
    cardRows: paymentRows,
    checkingAccounts: reader ? reader.listAccounts().map((account) => ({ id: account.id, last4: account.last4 ?? null })) : [],
    checkingRows: reader ? reader.listRows(ALL_DAYS) : [],
    decisions: decisionsState === 'present' ? listCardPaymentDecisions(db) : [],
    cardCoverage: [...coverage].map(([accountId, ranges]) => ({ accountId, ranges })),
    checkingCoverage: reader ? reader.coverage().map((item) => ({ accountId: item.checkingAccountId, ranges: item.ranges })) : [],
  });
  // A reversal's date: the later of its own transaction and posting dates (the issuer may not have shown it before).
  const reversalRows = new Map(paymentRows.map((row) => [row.id, row]));
  const reversalDate = (id: string): string | null => {
    const row = reversalRows.get(id);
    if (!row) return null;
    return row.postedDate !== undefined && row.postedDate > row.transactionDate ? row.postedDate : row.transactionDate;
  };
  const reversalDates = new Map<string, string>();
  const latest = (paymentId: string, dates: Array<string | null>) => {
    if (dates.length === 0 || dates.some((date) => date === null)) return;
    reversalDates.set(paymentId, (dates as string[]).sort()[dates.length - 1]);
  };
  for (const item of reconciliation.returned) latest(item.paymentId, [reversalDate(item.reversalId)]);
  const uncertain = reconciliation.unmatchedPayments.filter((item) => (item.possibleReversals?.length ?? 0) > 0);
  for (const item of uncertain) latest(item.paymentId, item.possibleReversals!.map((option) => reversalDate(option.reversalId)));
  return {
    installed: true,
    accounts,
    observations,
    rows,
    coverage,
    returned: new Set(reconciliation.returned.map((item) => item.paymentId)),
    uncertain: new Set(uncertain.map((item) => item.paymentId)),
    reversalDates,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /cash/payments
// ---------------------------------------------------------------------------------------------------------------------

export interface CashPaymentsCycleView extends Omit<CashPlanCycle, 'shown' | 'ledger'> {
  /** A and U at T as sums and counts (identities are not listed). */
  ledger: { provenMinor: number; possibleMinor: number; proven: number; possible: number };
}

export interface CashPaymentsCardView {
  cardAccountId: string;
  issuer: string;
  nickname: string | null;
  last4: string | null;
  owner: string;
  status: 'active' | 'closed';
  delinquency: CashPlanDelinquency | null;
  cycles: CashPaymentsCycleView[];
  bankReads: CashPlanBankRead[];
  attention: CashPlanAttentionItem[];
}

export interface CashPaymentsView {
  installed: boolean;
  mode: 'knowledge';
  asOf: string;
  today: string;
  timeZone: typeof CASH_PLAN_TIME_ZONE;
  rules: CashPlanRules;
  cards: CashPaymentsCardView[];
  totals: { red: number; amber: number; unknown: number; held: number };
}

const SETTLED = new Set(['paid-in-full', 'minimum-met', 'not-required']);

/** The engine over every card, as of `now` (knowledge mode), in the shape `GET /cash/payments` answers. */
export function cashPaymentsView(inputs: CashPlanInputs, now: Date): CashPaymentsView {
  const asOf = now.toISOString();
  const view: CashPaymentsView = {
    installed: inputs.installed,
    mode: 'knowledge',
    asOf,
    today: easternDate(now),
    timeZone: CASH_PLAN_TIME_ZONE,
    rules: { ...CASH_PLAN_RULES },
    cards: [],
    totals: { red: 0, amber: 0, unknown: 0, held: inputs.observations.filter((o) => o.status === 'held').length },
  };
  if (!inputs.installed) return view;
  for (const account of inputs.accounts) {
    const plan: CardPlan = cashPlanForCard({
      card: { id: account.id, issuer: account.issuer, currency: account.currency, status: account.status },
      observations: inputs.observations.filter((o) => o.cardAccountId === account.id),
      rows: inputs.rows.filter((row) => row.cardAccountId === account.id),
      returnedPaymentIds: inputs.returned,
      uncertainPaymentIds: inputs.uncertain,
      reversalDates: inputs.reversalDates,
      coverage: inputs.coverage.get(account.id) ?? [],
      asOf,
    });
    const shown = plan.cycles.filter((cycle) => cycle.shown);
    if (account.status === 'closed' && !closedCardStillMatters(plan, shown, inputs.observations.filter((o) => o.cardAccountId === account.id && o.status === 'accepted'))) continue;
    view.cards.push({
      cardAccountId: account.id,
      issuer: account.issuer,
      nickname: account.nickname,
      last4: account.last4 ?? (account.last5 ? account.last5.slice(-4) : null),
      owner: account.owner,
      status: account.status,
      delinquency: plan.delinquency,
      cycles: shown.map(({ shown: _shown, ledger, ...cycle }) => ({
        ...cycle,
        ledger: { provenMinor: ledger.provenMinor, possibleMinor: ledger.possibleMinor, proven: ledger.proven.length, possible: ledger.possible.length },
      })),
      bankReads: plan.bankReads,
      attention: plan.attention,
    });
    for (const item of plan.attention) view.totals[item.severity]++;
    const newest = shown[0];
    if ((shown.length === 0 && plan.bankReads.length === 0) || (newest !== undefined && (newest.state === 'unknown' || newest.state === 'unknown-coverage'))) view.totals.unknown++;
  }
  return view;
}

/** A closed card stays while it has an unresolved cycle, an open delinquency, or a positive balance in its newest fact. */
function closedCardStillMatters(plan: CardPlan, shown: readonly CashPlanCycle[], accepted: readonly CardScheduleObservation[]): boolean {
  if (plan.delinquency !== null) return true;
  if (shown.some((cycle) => !SETTLED.has(cycle.state))) return true;
  const newest = [...accepted].sort((a, b) => observationAsOf(b).lowerMs - observationAsOf(a).lowerMs || (a.id < b.id ? -1 : 1))[0];
  return newest !== undefined && [newest.statementBalanceMinor, newest.remainingStatementMinor, newest.currentBalanceMinor].some((value) => value !== null && value > 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// holdr-cash import
// ---------------------------------------------------------------------------------------------------------------------

export interface CashPlanImportSummary {
  inserted: number;
  duplicates: number;
  held: Partial<Record<CardScheduleHeldReason, number>>;
  /** Distinct cards the accepted and held rows bound to. */
  cards: number;
  /** The due dates the inserted rows name, earliest to latest. */
  dueDateRange: { from: string; to: string } | null;
}

/**
 * The card an observation names: exactly one card of its issuer and last four or five digits, in its currency. An owner
 * or a nickname the reference names narrows the cards it can be (the nickname compared by `cardNicknameKey`): two
 * cards that share an ending are told apart, never guessed between.
 */
function bindCard(card: ValidCardScheduleObservation['card'], currency: string, accounts: readonly CashPlanAccount[]):
  { cardAccountId: string } | { held: 'unbound' | 'ambiguous-card' | 'invalid' } {
  const nickname = card.nickname === undefined ? null : cardNicknameKey(card.nickname);
  const matches = accounts.filter((account) => {
    if (account.issuer !== card.issuer) return false;
    if (card.owner !== undefined && account.owner !== card.owner) return false;
    if (nickname !== null && (account.nickname === null || cardNicknameKey(account.nickname) !== nickname)) return false;
    const accountLast4 = account.last4 ?? (account.last5 ? account.last5.slice(-4) : null);
    if (card.last5 !== null && account.last5 !== null) return account.last5 === card.last5;
    const wanted = card.last4 ?? card.last5!.slice(-4);
    return accountLast4 === wanted;
  });
  if (matches.length === 0) return { held: 'unbound' };
  if (matches.length > 1) return { held: 'ambiguous-card' };
  if (matches[0].currency !== currency) return { held: 'invalid' };
  return { cardAccountId: matches[0].id };
}

/**
 * Appends validated observations (inside the caller's backed-up IMMEDIATE transaction). Each binds to exactly one card of
 * its issuer, last digits and currency (and, where its reference names them, owner and nickname), or is held
 * (`unbound`, `ambiguous-card`, `invalid`); nothing is guessed. A row already stored with the same card and payload digest
 * (or the same digest earlier in this file) is a duplicate and inserts nothing. The table must be present.
 */
export function importCardScheduleObservations(db: Database, observations: readonly ValidCardScheduleObservation[],
  options: { importRef: string; now: string; dryRun?: boolean }): CashPlanImportSummary {
  if (cashPlanSchemaState(db) !== 'present') throw new HoldrRefusal(CASH_PLAN_REFUSALS.notInstalled);
  const accounts = db.prepare(`SELECT id, issuer, owner, nickname, last4, last5, currency, status FROM card_accounts`).all() as CashPlanAccount[];
  const exists = db.prepare(`SELECT 1 FROM ${TABLE} WHERE card_account_id IS ? AND payload_digest = ?`);
  const insert = options.dryRun ? null : db.prepare(`INSERT INTO ${TABLE} (id, card_account_id, issuer, currency, source_kind, source_ref, observed_at, financial_as_of,
      as_of_source, as_of_precision, import_ref, payload_digest, extractor_version, statement_period_start_date, statement_closing_date,
      payment_due_date, statement_balance_minor, minimum_due_minor, minimum_basis, remaining_statement_minor, current_balance_minor,
      past_due_minor, last_payment_date, last_payment_minor, scheduled_payment_date, scheduled_payment_minor, autopay, autopay_fixed_minor,
      issuer_phrase, status, held_reason, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const summary: CashPlanImportSummary = { inserted: 0, duplicates: 0, held: {}, cards: 0, dueDateRange: null };
  const cards = new Set<string>();
  const seen = new Set<string>();
  const dues: string[] = [];
  for (const o of observations) {
    const binding = bindCard(o.card, o.currency, accounts);
    const cardAccountId = 'cardAccountId' in binding ? binding.cardAccountId : null;
    const heldReason: CardScheduleHeldReason | null = 'held' in binding ? binding.held : o.heldReason;
    const payloadDigest = cardSchedulePayloadDigest(o, cardAccountId !== null ? { cardAccountId } : { unboundCard: o.card }, heldReason);
    const key = `${cardAccountId}|${payloadDigest}`;
    if (seen.has(key) || exists.get(cardAccountId, payloadDigest) !== undefined) {
      summary.duplicates++;
      continue;
    }
    seen.add(key);
    if (insert !== null) {
      insert.run(`cso-${randomCardSyncLetters()}`, cardAccountId, o.card.issuer, o.currency, o.sourceKind, o.sourceRef, o.observedAt,
        o.financialAsOf, o.asOfSource, o.asOfPrecision, options.importRef, payloadDigest, o.extractorVersion, o.statementPeriodStartDate,
        o.statementClosingDate, o.paymentDueDate, o.statementBalanceMinor, o.minimumDueMinor, o.minimumBasis, o.remainingStatementMinor,
        o.currentBalanceMinor, o.pastDueMinor, o.lastPaymentDate, o.lastPaymentMinor, o.scheduledPaymentDate, o.scheduledPaymentMinor,
        o.autopay, o.autopayFixedMinor, o.issuerPhrase, heldReason === null ? 'accepted' : 'held', heldReason, options.now);
    }
    summary.inserted++;
    if (heldReason !== null) summary.held[heldReason] = (summary.held[heldReason] ?? 0) + 1;
    if (cardAccountId !== null) cards.add(cardAccountId);
    if (o.paymentDueDate !== null) dues.push(o.paymentDueDate);
  }
  summary.cards = cards.size;
  dues.sort();
  summary.dueDateRange = dues.length > 0 ? { from: dues[0], to: dues[dues.length - 1] } : null;
  return summary;
}
