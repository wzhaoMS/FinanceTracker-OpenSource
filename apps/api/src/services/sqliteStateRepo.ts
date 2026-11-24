import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  assignCardDedupeKeys,
  BENEFITS_CATALOG,
  reconcileCardImport,
  type CardImportPayload,
  type CardImportPayloadRow,
  type CardImportReconciliation,
  canonicalCardDescription,
  CARD_UNCATEGORIZED,
  cardCoverageContains,
  cardMerchantKey,
  matchesCardMerchantGroup,
  cardTransactionFingerprint,
  containsCardData,
  containsCardSecret,
  containsLongDigitRun,
  effectiveCardKind,
  isCardAssetCategory,
  isCardExternalIdHash,
  LONG_DIGIT_RUN,
  mergeCardCoverage,
  normalizeCardText,
  parseCardAmountQuery,
  serializeCardImportPayload,
  toLetterHex,
} from '@finance-tracker/shared';
import type {
  Account,
  BenefitCatalog,
  BenefitCreditRow,
  CardAccount,
  CardAccountCoverage,
  CardAccountStatus,
  CardBenefitMark,
  CardBenefitSettings,
  CardDedupeKey,
  CardImportBatch,
  CardOwner,
  CardSpendingRule,
  CardTransaction,
  CardTransactionKind,
  CardTransactionStatus,
  CashEvent,
  CashEventInput,
  CashEventType,
  CostBasisCheck,
  IssuerBenefitTrackerRecord,
  Transaction,
} from '@finance-tracker/shared';
import {
  CARD_GUARD_CHECKS,
  CARD_SCHEMA,
  CARD_TABLES,
  cardColumnLabel,
  cardGuardMessage,
  guardCovers,
  type CardTable,
  type GuardColumn,
} from './cardGuards.js';
import { CARD_SYNC_VERSION, migrateCardSyncSchema } from './cardLedger/migrateV15.js';
import { indexesOf, isDismissedPending, isPromotablePending, keyOf, planImport, type ImportPlan } from './cardImport/plan.js';
import { cardImportPreviewDigest, fileReviewWork, persistFileReviewSets, type FileReviewInput } from './cardImport/review.js';
import { CardLedgerWriter, sessionActor, type FileRowValues, type LedgerActor, type LegacyHit } from './cardLedger/writer.js';
import {
  CardBenefitsStore,
  ensureCardBenefitsSchema,
  type CardBenefitMarkInput,
  type CardBenefitMarkKey,
  type CardBenefitSettingsInput,
  type CardBenefitTrackerResult,
} from './cardBenefits.js';
import {
  cardSpendingRulesSchemaState,
  createCardSpendingRule as createSpendingRule,
  listCardSpendingRules as listSpendingRules,
  revokeCardSpendingRule as revokeSpendingRule,
} from './cardSpendingRules.js';
import {
  cardOpeningMonthsSchemaState,
  clearCardOpeningMonth as clearOpeningMonth,
  confirmCardOpeningMonths as confirmOpeningMonths,
  listCardOpeningMonths as listOpeningMonths,
  type CardFirstKnownDays,
  type CardOpeningMonthRecord,
} from './cardOpeningMonths.js';
import {
  cardPaymentDecisionsSchemaState,
  listCardPaymentDecisions as listPaymentDecisions,
  recordCardPaymentDecision as recordPaymentDecision,
  revokeCardPaymentDecision as revokePaymentDecision,
  type CardPaymentDecisionInput,
  type CardPaymentDecisionRecord,
  type CardPaymentDecisionsSchemaState,
} from './cardPaymentDecisions.js';
import type { CardSyncAuthChange } from './cardSync/principals.js';
import * as cardSyncBindings from './cardSync/bindings.js';
import type { CardSourceBindingView } from './cardSync/bindings.js';
import * as cardSyncDevices from './cardSync/devices.js';
import * as cardSyncRuns from './cardSync/runs.js';
import type { CardSyncRunCursor, CardSyncRunView } from './cardSync/runs.js';
import type {
  CardSyncDeviceAuth, CardSyncDeviceView, CardSyncPairingView, CardSyncRedeemResult,
} from './cardSync/devices.js';
import { addDays } from './cardLedger/classify.js';
import * as cardSyncSettings from './cardSync/settings.js';
import * as cardSyncOwner from './cardSync/owner.js';
import * as cardSyncOwnerAuthorization from './cardSync/ownerAuthorization.js';
import type * as cardSyncOwnerViews from './cardSync/ownerViews.js';
import * as cardSyncRecovery from './cardSync/recovery.js';
import * as cardSyncRetention from './cardSync/retention.js';
import * as cardSyncCoverage from './cardSync/coverage.js';
import * as cardSyncLedger from './cardSync/ledger.js';
import * as cardSyncReview from './cardSync/review.js';
import * as cardSyncPlans from './cardSync/plans.js';
import * as cardSyncAcceptance from './cardSync/acceptance.js';
import { sessionActorRef } from './cardSync/context.js';
import * as cardSyncSets from './cardSync/sets.js';
import { CardSyncStatements } from './cardSyncStatements.js';
import type { CardSyncContext, CardSyncGenerationStep, CardSyncSettings } from './cardSync/settings.js';
import { newCardSyncRowId, rowContentDigest } from './cardSyncDigests.js';
import { CARD_PARSER_VERSION, CARD_SLUG } from './cardV1Grammar.js';
import { HoldrRefusal, toValueFreeDbError, withValueFreeDbErrors } from './dbErrors.js';
import type { PersistedState } from './jsonStateRepo.js';
import { validatePersistedState } from './jsonStateRepo.js';
import { ensurePrivateDataDir } from './privateDataDir.js';

/**
 * SQLite-backed implementation of the same `{ accounts, transactions }` shape
 * the API has always exposed via `GET/PUT /state`.
 *
 * Phase 2 deliberately keeps the API shape identical so the web client does
 * not change. Phase 3 will replace this whole-blob interface with per-resource
 * endpoints.
 *
 * Schema:
 *   accounts(id, name, type?, cash_balance, currency, sort_order)
 *   transactions(id, account_id FK→accounts, symbol, date, quantity,
 *                price_per_unit, fees?, currency, notes?, sort_order)
 *
 * `sort_order` preserves the array ordering callers send us in `PUT /state`,
 * so a round-trip is byte-for-byte stable in user-facing terms.
 *
 * Writes are wrapped in a single transaction. The shape gets re-validated
 * before any DB work so a malformed payload cannot leave the DB half-updated.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT,
  cash_balance   REAL NOT NULL,
  currency       TEXT NOT NULL,
  sort_order     INTEGER NOT NULL,
  account_number TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  symbol            TEXT NOT NULL,
  date              TEXT NOT NULL,
  quantity          REAL NOT NULL,
  price_per_unit    REAL NOT NULL,
  instrument_type   TEXT,
  contract_multiplier INTEGER,
  position_effect   TEXT,
  fees              REAL,
  currency          TEXT NOT NULL,
  notes             TEXT,
  sort_order        INTEGER NOT NULL,
  source_fingerprint TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
-- The partial unique index for source_fingerprint is created by
-- ensureSourceFingerprintColumn() after that column has been ALTERed in.
-- (Putting CREATE UNIQUE INDEX here would break on legacy DBs that run
-- SCHEMA_SQL before the migration: the column would not exist yet.)

-- Phase 4 Google-OAuth household tables. Dormant: sign-in uses the local
-- password tables below instead (users.google_sub and users.email are
-- NOT NULL, which local accounts cannot satisfy without placeholders).
CREATE TABLE IF NOT EXISTS households (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  google_sub    TEXT NOT NULL UNIQUE,
  picture       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (household_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,        -- sha256(opaque cookie value), hex
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS oauth_state (
  state              TEXT PRIMARY KEY,  -- opaque random ID
  csrf_hash          TEXT NOT NULL,     -- sha256 of the state cookie value
  invite_token_hash  TEXT,              -- sha256 of the bound invite token, if any
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash    TEXT PRIMARY KEY,       -- sha256 of the raw token
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at    TEXT NOT NULL,
  redeemed_by   TEXT REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Local username/password sign-in. Accounts are managed only by the
-- server-side holdr-user CLI. password_hash is a self-describing scrypt string
-- (parameters + salt + key). Sessions store sha256(cookie token), never the
-- token itself, and disappear with their user. Created idempotently on every
-- open, so these tables need no user_version bump.
CREATE TABLE IF NOT EXISTS local_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS local_sessions (
  id           TEXT PRIMARY KEY,        -- sha256(cookie token), hex
  user_id      TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  renewed_at   TEXT NOT NULL,
  -- 1 = issued as a Secure __Host- cookie (HTTPS mode). HTTPS mode never
  -- honours a 0 row: its token may have crossed the network in plain HTTP.
  secure       INTEGER NOT NULL DEFAULT 0 CHECK (secure IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_local_sessions_user ON local_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_local_sessions_expiry ON local_sessions(expires_at);

-- Phase C.1: cached daily/intraday price bars for symbol-history charts.
-- Bars are immutable history; we never overwrite a (symbol, range_kind, t)
-- once stored. Multiple sources can coexist (e.g. nasdaq daily + coingecko
-- daily for crypto), so source is part of the PK.
CREATE TABLE IF NOT EXISTS symbol_price_bars (
  symbol      TEXT NOT NULL,
  range_kind  TEXT NOT NULL CHECK (range_kind IN ('intraday', 'daily')),
  t           TEXT NOT NULL,            -- YYYY-MM-DD for daily, ISO 8601 for intraday
  close       REAL NOT NULL,
  open        REAL,
  high        REAL,
  low         REAL,
  volume      REAL,
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (symbol, range_kind, t, source)
);
CREATE INDEX IF NOT EXISTS idx_bars_symbol_t ON symbol_price_bars(symbol, range_kind, t);

-- Phase B.1: portfolio value snapshots. Emitted by the in-process snapshot
-- job (gated by SNAPSHOTS_ENABLED=1). Each row is one account's value
-- at one point in time; portfolio history is the sum across accounts at
-- the same taken_at. UNIQUE on (account_id, taken_at) makes job retries
-- idempotent. Cost basis stored at snapshot time so historical +X% is
-- immutable. If a transaction is added later, v11 records the interval as
-- unreliable instead of pretending the old observation was complete.
CREATE TABLE IF NOT EXISTS account_snapshots (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  taken_at     TEXT NOT NULL,
  market_value REAL NOT NULL,
  cost_basis   REAL NOT NULL,
  cash_balance REAL NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_account_time
  ON account_snapshots(account_id, taken_at);

-- A late broker import cannot safely rewrite already-captured market values:
-- the historical quote (especially for options) may no longer be available.
-- Record the affected interval so history can stop presenting those snapshots
-- as exact while preserving the original observations for audit.
CREATE TABLE IF NOT EXISTS account_history_invalidations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  detected_at    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Deliberately no FK: legacy account-table rebuilds rename FK targets before
-- the transaction table is rebuilt. deleteAccount removes these audit rows
-- explicitly so account IDs can never retain orphaned invalidations.
CREATE INDEX IF NOT EXISTS idx_history_invalidations_account_interval
  ON account_history_invalidations(account_id, effective_date, detected_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_invalidations_unique
  ON account_history_invalidations(account_id, effective_date, detected_at, reason);

-- Broker-observed account values from statements. These are kept separate
-- from Holdr snapshots because their provenance and financial meaning differ.
-- A repeated import of the same document/date is idempotent, while a corrected
-- statement with a different hash is preserved for explicit reconciliation.
CREATE TABLE IF NOT EXISTS account_nav_history (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  broker                 TEXT NOT NULL,
  observed_at            TEXT NOT NULL,
  nav                    REAL NOT NULL,
  currency               TEXT NOT NULL,
  statement_period_start TEXT NOT NULL,
  statement_period_end   TEXT NOT NULL,
  account_last4          TEXT NOT NULL,
  source_document_hash   TEXT NOT NULL,
  source_file_name       TEXT,
  source_page            INTEGER NOT NULL,
  imported_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_nav_source
  ON account_nav_history(account_id, observed_at, source_document_hash);
CREATE INDEX IF NOT EXISTS idx_account_nav_account_date
  ON account_nav_history(account_id, observed_at);

-- Append-only broker cash movements. Kept separate from transactions so
-- position math cannot accidentally treat a dividend or transfer as shares.
-- Signed amount is from the account's perspective (inflow +, outflow -).
CREATE TABLE IF NOT EXISTS account_cash_events (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  event_date         TEXT NOT NULL,
  event_type         TEXT NOT NULL CHECK (event_type IN (
    'deposit', 'withdrawal', 'dividend', 'interest',
    'transfer', 'fee', 'tax', 'sweep'
  )),
  amount             REAL NOT NULL CHECK (amount <> 0),
  currency           TEXT NOT NULL,
  broker             TEXT NOT NULL,
  account_last4      TEXT NOT NULL,
  description        TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  imported_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_events_source
  ON account_cash_events(account_id, source_fingerprint);
CREATE INDEX IF NOT EXISTS idx_cash_events_account_date
  ON account_cash_events(account_id, event_date);

-- v12: broker end-of-day cash balances, rebuilt from broker activity exports
-- (the balance after every posted row of a day). Long-range history values
-- cash from these rows instead of holding today's balance flat. One row per
-- (account, date): re-importing identical values is a no-op and a differing
-- value is rejected rather than silently overwritten. No FK, matching the
-- invalidation table: deleteAccount refuses while rows exist.
CREATE TABLE IF NOT EXISTS account_cash_history (
  account_id    TEXT NOT NULL,
  as_of_date    TEXT NOT NULL,
  cash_balance  REAL NOT NULL,
  currency      TEXT NOT NULL,
  broker        TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  source_hash   TEXT NOT NULL,
  method        TEXT NOT NULL,
  imported_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, as_of_date)
);

-- Single-writer lease for the snapshot scheduler. One row per active
-- writer; a lease older than expires_at is considered stale and any
-- starting writer can take it.
CREATE TABLE IF NOT EXISTS snapshot_lease (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- enforce singleton
  holder       TEXT NOT NULL,                       -- pid@host or similar
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- Phase E.7: manual price overrides for unlisted holdings (e.g. employer-only
-- VANG500 trust, private placements, illiquid funds). One row per
-- (symbol, date); user-entered closes used by portfolio reconstruction in
-- preference to provider data when both exist. Symbol stored uppercase.
CREATE TABLE IF NOT EXISTS manual_prices (
  symbol     TEXT NOT NULL,
  date       TEXT NOT NULL,                         -- YYYY-MM-DD
  close      REAL NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_manual_prices_symbol ON manual_prices(symbol);
`;

/**
 * Schema version. v1 = accounts/transactions, v2 = auth tables, v3 = symbol
 * price-history cache, v4 = portfolio snapshots + scheduler lease,
 * v5 = manual_prices (E.7).
 * v6 = accounts.account_number (broker-import account matching).
 * v7 = transactions.source_fingerprint + partial unique index for
 *      idempotent broker-activity imports.
 * v8 = broker-observed account_nav_history with document provenance.
 * v9 = typed account_cash_events with broker provenance and idempotency.
 * v10 = option instrument metadata on transactions.
 * v11 = account history invalidation intervals for late broker imports.
 * v12 = broker end-of-day account_cash_history for long-range valuation.
 * v13 = credit-card spending: card_accounts, card_import_batches,
 *       card_transactions and their long-digit guard triggers.
 * v14 = spending reports: card_accounts.last5; import coverage on
 *       card_import_batches; the pending → posted link and pending
 *       dismissal on card_transactions.
 * v15 = card sync (E1b): source registries, card scopes, bindings, policy,
 *       pairings, devices, runs, durable observations, receipts, source
 *       identities, ledger events and snapshots, review items, coverage
 *       windows, commit plans, audit and payment links; card_transactions
 *       rebuilt with attribution and removal history; 113 invariant
 *       triggers (cardLedger/migrateV15.ts).
 */
export const CURRENT_USER_VERSION = 15;
const CARD_SPENDING_VERSION = 13;
const CARD_REPORTS_VERSION = 14;

/** The detectors behind a build's guard functions and its repository checks. */
export interface CardDetectors {
  /** Card numbers in any grouping or script. */
  containsCardData(text: string): boolean;
  /** Labeled security codes, PINs and expiry dates. */
  containsCardSecret(text: string): boolean;
}

/**
 * A build's card guard identity: the revision it stamps into the guards, the
 * SQL names of the detectors they call, and the detectors behind those names.
 */
export interface CardGuardBuild {
  revision: number;
  /** SQL name for `detectors.containsCardData`. */
  cardDataFunction: string;
  /** SQL name for `detectors.containsCardSecret`. */
  cardSecretFunction: string;
  detectors: Readonly<CardDetectors>;
}

/**
 * The card guards this build writes. The revision is stamped into each
 * trigger, and the triggers call the detectors under these versioned names.
 *
 * Any change that tightens the guards must bump the revision. That covers the
 * generated SQL (its checks are CARD_GUARD_CHECKS in cardGuards.ts), the
 * forbidden character ranges, and the card number or card secret detector the
 * triggers call (Phase 1's included). A tightened detector also gets a new
 * versioned name. A build with an older revision then refuses
 * the database (assertSupportedDatabase) instead of rewriting its guards or
 * writing through weaker detectors. A build from before revisions existed
 * cannot write card rows either, because it does not register the new names.
 * Behaviour-preserving changes (refactors, speed-ups) need neither. Whatever
 * replaces a table's guards first re-checks its stored rows against the new
 * ones, and refuses the database if any row fails (syncCardGuards).
 *
 * Rule: land every tightening atomically with its identity change. The
 * stronger detector, the revision bump and the new function names go into the
 * same commit, so no commit ever pairs a stronger detector with an identity a
 * weaker build also has. For a tightening Phase 1 change, make them inside the
 * merge commit itself: `git merge --no-commit`, bump the revision and rename
 * the functions, re-pin the tripwire test, then commit. The tripwire ('pins
 * the detectors and guard SQL to the guard revision' in sqliteStateRepo.test.ts)
 * fails on any change to a detector source or to the guard SQL until it is
 * re-pinned. Re-pin without a bump only for behaviour-preserving changes.
 *
 * Revision 1 (7e66b89 to f9273c8): first guards, as holdr_card_number and holdr_card_secret.
 * Revision 2 (a075553): secret detection for quoted, structured, delimited
 *   and bracketed annotations; Phase 1 card number detection as of 72d436f.
 * Revision 3 (9eac1b2 to 1f1ffbf): Phase 1 card number detection as of
 *   06e694d (truncated, continued and punctuation-grouped numbers). b9c66dd
 *   shipped that detector under revision 2 by mistake, so a075553 could open
 *   its databases. Both refuse revision 3.
 * Revision 4 (the merge of Phase 1 5d0467e): span-based card data detection.
 *   No card-length span may show more than four digits, and a run of masks
 *   followed by five or more digits is card data at any length.
 */
export const CARD_GUARD_BUILD: Readonly<CardGuardBuild> = Object.freeze({
  revision: 4,
  cardDataFunction: 'holdr_card_data_v4',
  cardSecretFunction: 'holdr_card_secret_v4',
  detectors: Object.freeze({ containsCardData, containsCardSecret }),
});
const CARD_GUARD_REVISION_LINE = /^-- holdr card guard revision (\d+)$/m;

/**
 * v13: credit-card spending, kept apart from the brokerage ledger. Nothing
 * here references `accounts`; brokerage cash, cash history, holdings and
 * returns never read these tables.
 *
 * No column can hold a card number: `last4` is the only card identifier,
 * issuer references are stored only as `cardExternalIdHash` values (letter
 * hex, no digits), and the triggers from `syncCardGuards` check every column
 * on INSERT and UPDATE. Length caps keep raw export lines out of the
 * free-text columns. Shape CHECKs compare the stored type and byte length as
 * well as a GLOB, because GLOB and length() stop at an embedded NUL while
 * SQLite stores the bytes after it.
 *
 * Unlike SCHEMA_SQL this is plain CREATE, run once inside the v13 upgrade
 * transaction, so an existing object with one of these names aborts the
 * upgrade instead of being silently adopted.
 */
const CARD_SCHEMA_SQL = `
CREATE TABLE card_accounts (
  id          TEXT PRIMARY KEY,
  issuer      TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 32),
  owner       TEXT NOT NULL CHECK (owner IN ('alex', 'casey', 'joint')),
  nickname    TEXT CHECK (nickname IS NULL OR length(nickname) BETWEEN 1 AND 80),
  -- Exactly the four digits the issuer shows, never padded.
  last4       TEXT CHECK (last4 IS NULL OR (
    typeof(last4) = 'text' AND length(CAST(last4 AS BLOB)) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]')),
  currency    TEXT NOT NULL CHECK (
    typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Deliberately not unique: last-4 collisions are legal, and supplementary and
-- reissued cards are recorded under their billing account.
CREATE INDEX idx_card_accounts_identity ON card_accounts(issuer, owner, last4);

-- One row per committed import: provenance and counts, never file names or
-- raw content.
CREATE TABLE card_import_batches (
  id               TEXT PRIMARY KEY,
  card_account_id  TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  source           TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  parser_version   TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  row_count        INTEGER NOT NULL CHECK (row_count = CAST(row_count AS INTEGER) AND row_count >= 0),
  new_count        INTEGER NOT NULL CHECK (new_count = CAST(new_count AS INTEGER) AND new_count >= 0),
  duplicate_count  INTEGER NOT NULL CHECK (duplicate_count = CAST(duplicate_count AS INTEGER) AND duplicate_count >= 0),
  rejected_count   INTEGER NOT NULL CHECK (rejected_count = CAST(rejected_count AS INTEGER) AND rejected_count >= 0),
  imported_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (new_count + duplicate_count + rejected_count = row_count)
);
CREATE INDEX idx_card_import_batches_account ON card_import_batches(card_account_id, imported_at);

-- amount_minor is integer minor units: positive = money spent (purchase, fee,
-- interest), negative = money back (refund, payment, cashback). A card payment
-- is a transfer, not spending. Each row has exactly one dedupe key, unique per
-- card account: the hash of the issuer's stable reference (OFX FITID, Amex
-- Reference, ...) or, without one, a fingerprint of date, amount, description
-- and occurrence among id-less rows, so two identical purchases are both kept.
-- \`x = CAST(x AS INTEGER)\` holds whether or not affinity has already turned a
-- bound REAL into an INTEGER, and rejects fractions, text and blobs.
CREATE TABLE card_transactions (
  id                     TEXT PRIMARY KEY,
  card_account_id        TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  source                 TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  external_id_hash       TEXT CHECK (external_id_hash IS NULL OR (
    typeof(external_id_hash) = 'text' AND length(CAST(external_id_hash AS BLOB)) = 69
    AND external_id_hash GLOB 'xid[1-9]:*' AND substr(external_id_hash, 6) NOT GLOB '*[^a-p]*')),
  fingerprint            TEXT CHECK (fingerprint IS NULL OR (
    typeof(fingerprint) = 'text' AND length(CAST(fingerprint AS BLOB)) = 69
    AND fingerprint GLOB 'cfp[1-9]:*' AND substr(fingerprint, 6) NOT GLOB '*[^a-p]*')),
  transaction_date       TEXT NOT NULL CHECK (
    typeof(transaction_date) = 'text' AND length(CAST(transaction_date AS BLOB)) = 10
    AND transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  posted_date            TEXT CHECK (posted_date IS NULL OR (
    typeof(posted_date) = 'text' AND length(CAST(posted_date AS BLOB)) = 10
    AND posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'removed')),
  amount_minor           INTEGER NOT NULL CHECK (
    amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND 999999999999),
  currency               TEXT NOT NULL CHECK (
    typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  original_amount_minor  INTEGER CHECK (original_amount_minor IS NULL OR (
    original_amount_minor = CAST(original_amount_minor AS INTEGER)
    AND original_amount_minor BETWEEN -999999999999 AND 999999999999)),
  original_currency      TEXT CHECK (original_currency IS NULL OR (
    typeof(original_currency) = 'text' AND length(CAST(original_currency AS BLOB)) = 3
    AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  kind                   TEXT NOT NULL CHECK (kind IN (
    'purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'
  )),
  description            TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  merchant               TEXT CHECK (merchant IS NULL OR length(merchant) BETWEEN 1 AND 200),
  issuer_category        TEXT CHECK (issuer_category IS NULL OR length(issuer_category) BETWEEN 1 AND 100),
  user_category          TEXT CHECK (user_category IS NULL OR length(user_category) BETWEEN 1 AND 100),
  notes                  TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  import_batch_id        TEXT REFERENCES card_import_batches(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((external_id_hash IS NULL) <> (fingerprint IS NULL)),
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL))
);
CREATE UNIQUE INDEX idx_card_transactions_external_id
  ON card_transactions(card_account_id, external_id_hash) WHERE external_id_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_card_transactions_fingerprint
  ON card_transactions(card_account_id, fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX idx_card_transactions_account_date ON card_transactions(card_account_id, transaction_date);
CREATE INDEX idx_card_transactions_batch ON card_transactions(import_batch_id);
`;

/**
 * v14: spending reports, as ALTERs on the v13 card tables (run once inside
 * the upgrade transaction, so an existing column of the same name aborts it).
 *
 * - `card_accounts.last5`: the five digits some issuers show at the end of
 *   the account (American Express), so two cards whose last four digits
 *   collide stay apart. It must end with `last4`; nothing longer is stored.
 * - `card_import_batches.coverage_start/_end`: the inclusive dates an import
 *   spoke for, so the Spending tab can show what has been imported and where
 *   the gaps are. NULL on batches written before v14.
 * - `card_transactions.dismissed_at`: when someone dismissed a pending row
 *   (it will not post, or it posted under another reference). The row stays,
 *   as removed, and can be restored; nothing removes a row automatically.
 */
const CARD_REPORTS_SCHEMA_SQL = `
ALTER TABLE card_accounts ADD COLUMN last5 TEXT CHECK (last5 IS NULL OR (
  typeof(last5) = 'text' AND length(CAST(last5 AS BLOB)) = 5 AND last5 GLOB '[0-9][0-9][0-9][0-9][0-9]'
  AND last4 IS NOT NULL AND substr(last5, 2) = last4));
ALTER TABLE card_import_batches ADD COLUMN coverage_start TEXT CHECK (coverage_start IS NULL OR (
  typeof(coverage_start) = 'text' AND length(CAST(coverage_start AS BLOB)) = 10
  AND coverage_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
ALTER TABLE card_import_batches ADD COLUMN coverage_end TEXT CHECK ((coverage_end IS NULL AND coverage_start IS NULL) OR (
  coverage_start IS NOT NULL AND typeof(coverage_end) = 'text' AND length(CAST(coverage_end AS BLOB)) = 10
  AND coverage_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND coverage_end >= coverage_start));
ALTER TABLE card_transactions ADD COLUMN dismissed_at TEXT CHECK (dismissed_at IS NULL OR (
  typeof(dismissed_at) = 'text' AND length(dismissed_at) BETWEEN 20 AND 30 AND status = 'removed'));
`;

/**
 * Second comment line of every guard; a comment, so guards with or without it
 * run the same checks. Builds before this one installed guards without
 * re-checking stored rows, and their guard SQL lacks this line, so a database
 * one of them upgraded gets its rows checked on the next open here.
 */
const CARD_GUARD_ROWS_CHECKED = '-- installed only after every stored row passed these checks';

/**
 * SQL functions the guard triggers call, so card number and card secret
 * detection run at the SQL boundary too. Card rows can only be written
 * through a connection that registers them under this build's names; other
 * SQLite clients, and builds that only know older names, can still read and
 * back up the card tables, but their card writes fail with "no such function".
 */
function registerCardFunctions(db: DB, guards: CardGuardBuild, detectors: Readonly<CardDetectors>): void {
  for (const name of [guards.cardDataFunction, guards.cardSecretFunction]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new HoldrRefusal('card guard function names must be SQL identifiers');
  }
  db.function(guards.cardDataFunction, { deterministic: true }, (value: unknown) =>
    (typeof value === 'string' && detectors.containsCardData(value) ? 1 : 0));
  db.function(guards.cardSecretFunction, { deterministic: true }, (value: unknown) =>
    (typeof value === 'string' && detectors.containsCardSecret(value) ? 1 : 0));
}

/** This build's card guard functions on an operator command's own connection, so it can write guarded card rows. */
export function registerCardGuardFunctions(db: DB): void {
  registerCardFunctions(db, CARD_GUARD_BUILD, CARD_GUARD_BUILD.detectors);
}

/** How many short texts a connection remembers as clean, and how long such a text may be. */
const CLEAN_TEXTS_REMEMBERED = 4096;
const CLEAN_TEXT_MAX_LENGTH = 256;

/**
 * This build's detectors for one connection, sharing one memory of the short
 * texts that both detectors found clean, for the repository's own checks
 * and the guard functions alike. A v1 import's rows repeat most of their
 * text (dates, the import's time and ids, sources, statuses, merchants),
 * every guarded column of every row passes through both functions, and the
 * import has already checked its own fields, so this is much of what keeps
 * a 2,000-row import inside design §7.11's P4 (review r1, finding 2).
 *
 * Contract: only pure, text-only scalar predicates may be wrapped, whose
 * answer depends on the exact string and nothing else. A detector that also
 * reads context (an account's card hints, a column's kind, a guard
 * revision, any mutable state) must not reuse this wrapper unchanged: a
 * remembered "clean" would answer for another context.
 *
 * A text is remembered only once both detectors have found it clean, so a
 * text either of them refuses is never kept, whichever was asked first: a
 * card secret the number detector found clean is not remembered by the
 * number check (review r2, finding 1), and no card number or secret
 * outlives the call that refused it. Each wrapper still answers exactly as
 * its own detector does; on a miss for a short text it also asks the other
 * detector, only to decide whether to remember the text (its throw, if any,
 * just keeps the text out). The oldest text is forgotten first.
 */
export function rememberingCleanTexts(detectors: Readonly<CardDetectors>): Readonly<CardDetectors> {
  const clean = new Set<string>();
  const data = (text: string) => detectors.containsCardData(text);
  const secret = (text: string) => detectors.containsCardSecret(text);
  const cleanFor = (detect: (text: string) => boolean, text: string): boolean => {
    try {
      return !detect(text);
    } catch {
      return false;
    }
  };
  const remembering = (asked: (text: string) => boolean, other: (text: string) => boolean) => (text: string): boolean => {
    if (clean.has(text)) return false;
    if (asked(text)) return true;
    if (text.length <= CLEAN_TEXT_MAX_LENGTH && cleanFor(other, text)) {
      if (clean.size >= CLEAN_TEXTS_REMEMBERED) clean.delete(clean.values().next().value as string);
      clean.add(text);
    }
    return false;
  };
  return Object.freeze({ containsCardData: remembering(data, secret), containsCardSecret: remembering(secret, data) });
}

/**
 * One BEFORE trigger per table and event, running CARD_GUARD_CHECKS on every
 * column of the new row, check by check, so every column's storage type is
 * confirmed before any textual check runs. Messages are cardGuardMessage's,
 * which name a column only as cardColumnLabel allows.
 */
function cardGuardSql(
  table: CardTable,
  event: 'INSERT' | 'UPDATE',
  columns: readonly GuardColumn[],
  guards: CardGuardBuild,
): string {
  const branches = CARD_GUARD_CHECKS.flatMap((check) => columns
    .filter((column) => guardCovers(check, column))
    .map((column) => `    WHEN ${check.fails(`NEW."${column.name}"`, column, guards)} ` +
      `THEN RAISE(ABORT, '${cardGuardMessage(table, column, check)}')`));
  return [
    `CREATE TRIGGER trg_${table}_guard_${event.toLowerCase()}`,
    `BEFORE ${event} ON ${table}`,
    `-- holdr card guard revision ${guards.revision}`,
    CARD_GUARD_ROWS_CHECKED,
    'BEGIN',
    '  SELECT CASE',
    ...branches,
    '  END;',
    'END',
  ].join('\n');
}

/** A card table's columns from PRAGMA table_info, so columns added by later migrations are guarded too. */
function cardGuardColumns(db: DB, table: CardTable): GuardColumn[] {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
  if (columns.length === 0) throw new HoldrRefusal(`card spending table ${table} is missing`);
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column.name)) throw new HoldrRefusal(`card spending table ${table} has an unexpected column name`);
    if (column.type !== 'TEXT' && column.type !== 'INTEGER') {
      throw new HoldrRefusal(`${table}.${cardColumnLabel(table, column.name)} has a type the card guards do not cover`);
    }
  }
  return columns.map(({ name, type }) => ({ name, type: type as GuardColumn['type'] }));
}

/**
 * Creates or refreshes the guard triggers. The columns come from PRAGMA
 * table_info on every open, so a column added by a later migration is
 * guarded on upgraded databases too; a column of a type the guards do not
 * cover is an error. A trigger is replaced only when its SQL differs, so
 * reopening an up-to-date database writes nothing and checks no rows. Before
 * a table's guards are installed or replaced (a newer revision, a new column,
 * a missing or altered trigger), its stored rows must pass them.
 *
 * A schema upgrade (`upgrading`) re-checks the stored rows of every card
 * table, whether or not its guards change. A table the new schema leaves
 * alone keeps byte-identical guards (v15's `card_import_batches`), and
 * identical guards prove nothing about rows an outside tool wrote while they
 * were dropped and then put back (review r1, finding 1). The triggers
 * themselves are still replaced only where their SQL differs.
 */
function syncCardGuards(db: DB, guards: CardGuardBuild, { upgrading }: { upgrading: boolean }): void {
  const storedSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").pluck();
  const plans = CARD_TABLES.map((table) => {
    const columns = cardGuardColumns(db, table);
    const triggers = (['INSERT', 'UPDATE'] as const).map((event) => ({
      name: `trg_${table}_guard_${event.toLowerCase()}`,
      sql: cardGuardSql(table, event, columns, guards),
    }));
    return { table, columns, stale: triggers.filter((trigger) => storedSql.get(trigger.name) !== trigger.sql) };
  });
  assertStoredCardRowsPass(db, guards, upgrading ? plans : plans.filter((plan) => plan.stale.length > 0));
  for (const { table, stale } of plans) {
    for (const event of ['insert', 'update']) {
      // The first v13 pre-release named its digit-only guards this way; the
      // guards below supersede them.
      const legacy = `trg_${table}_long_digits_${event}`;
      if (storedSql.get(legacy) !== undefined) db.exec(`DROP TRIGGER ${legacy}`);
    }
    for (const trigger of stale) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      db.exec(trigger.sql);
    }
  }
}

const STORED_CARD_FAILURES_LISTED = 20;

/**
 * Re-checks the stored rows of the card tables whose guards are about to be
 * installed or replaced (on a schema upgrade, of every card table), with this
 * build's checks and detectors, so rows let in by older, weaker or missing
 * guards cannot outlive them. One streaming
 * pass per table returns only the failing rows; every stored value is
 * checked once. Any failure refuses the upgrade, and the caller's
 * transaction then leaves the database as it was.
 *
 * The error is value-free by construction: it holds this build's table names,
 * column names its schema defines (others are `<column>`), ids in its own
 * generated format, ordinals and counts. A row without such an id is named by
 * its ordinal among the table's failing rows in scan order. Nothing else
 * stored is read for the message, not even the rowid: a column can shadow
 * it, and a caller can set it to any integer.
 */
function assertStoredCardRowsPass(
  db: DB,
  guards: CardGuardBuild,
  tables: ReadonlyArray<{ table: CardTable; columns: readonly GuardColumn[] }>,
): void {
  const listed: string[] = [];
  let failures = 0;
  for (const { table, columns } of tables) {
    // An empty table has nothing to re-check (most of v15's on a new database).
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() === undefined) continue;
    const fails = columns.map((column) => `CASE ${CARD_GUARD_CHECKS
      .filter((check) => guardCovers(check, column))
      .map((check) => `WHEN ${check.fails(`"${column.name}"`, column, guards)} THEN 1`)
      .join(' ')} ELSE 0 END`);
    const failing = columns.map((column, index) => `CASE WHEN ${fails[index]} THEN ' ${index}' ELSE '' END`);
    const id = columns.some((column) => column.name === 'id') ? '"id"' : 'NULL';
    const rows = db
      .prepare(`SELECT ${id}, ${failing.join(' || ')} FROM ${table} WHERE ${fails.join(' OR ')}`)
      .raw()
      .iterate() as IterableIterator<[unknown, string]>;
    let ordinal = 0;
    for (const [rowId, indexes] of rows) {
      ordinal += 1;
      const row = typeof rowId === 'string' && CARD_SCHEMA[table].generatedId.test(rowId)
        ? rowId
        : `#${ordinal} (non-standard id)`;
      for (const index of indexes.trim().split(' ')) {
        failures += 1;
        if (listed.length < STORED_CARD_FAILURES_LISTED) {
          listed.push(`${table}.${cardColumnLabel(table, columns[Number(index)].name)} in row ${row}`);
        }
      }
    }
  }
  if (failures === 0) return;
  const more = failures > listed.length ? `, and ${failures - listed.length} more` : '';
  throw new HoldrRefusal(
    `stored card rows fail this build's card guards (revision ${guards.revision}): ${listed.join(', ')}${more}. ` +
      'Refusing to open the database; nothing was changed. Restore a backup made before those rows were written, ' +
      'or fix or delete them with the build that wrote them, then open the database with this build again.',
  );
}

const CARD_GUARD_REVISION_MARKER = '-- holdr card guard revision ';
/** How many bytes of a trigger's text after its first revision marker are read to find the revision without the rest. */
const CARD_GUARD_REVISION_WINDOW = 24;

/**
 * Highest guard revision stamped into any trigger on a card table; 0 when
 * none carries one. A trigger's revision is CARD_GUARD_REVISION_LINE's first
 * match in its text. SQLite finds each trigger's first marker, so only the
 * byte before it and a few after it reach JavaScript (v15's 62 guards hold
 * about 1 MB of SQL, and the constructor checks twice). It works on bytes,
 * as JavaScript's text keeps every ASCII byte where it is whatever surrounds
 * it (SQLite's own text functions count characters differently around NULs
 * and malformed UTF-8). When that marker does not begin an exact revision
 * line, the whole text is read and matched instead, so the result is the
 * regular expression's in every case.
 */
function storedCardGuardRevision(db: DB): number {
  const at = 'instr(CAST(sql AS BLOB), CAST(:marker AS BLOB))';
  const marked = db
    .prepare(
      `SELECT name, ${at} AS at, substr(CAST(sql AS BLOB), ${at} - 1, 1) AS before,
              substr(CAST(sql AS BLOB), ${at} + ${Buffer.byteLength(CARD_GUARD_REVISION_MARKER)}, ${CARD_GUARD_REVISION_WINDOW}) AS after
         FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name IN (${CARD_TABLES.map((_, i) => `:t${i}`).join(', ')}) AND ${at} > 0`,
    )
    .all({ marker: CARD_GUARD_REVISION_MARKER, ...Object.fromEntries(CARD_TABLES.map((table, i) => [`t${i}`, table])) }) as Array<{
    name: string; at: number; before: Buffer; after: Buffer;
  }>;
  let fullText: Statement | undefined;
  return marked.reduce((highest, trigger) => {
    const line = /^([0-9]+)(\n|$)/.exec(trigger.after.toString('latin1'));
    let revision: string | undefined;
    if ((trigger.at === 1 || trigger.before[0] === 0x0a) && line
      && (line[2] === '\n' || trigger.after.length < CARD_GUARD_REVISION_WINDOW)) {
      revision = line[1];
    } else {
      fullText ??= db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?");
      const sql = (fullText.get(trigger.name) as { sql: string | null } | undefined)?.sql ?? '';
      revision = CARD_GUARD_REVISION_LINE.exec(sql)?.[1];
    }
    return revision === undefined ? highest : Math.max(highest, Number(revision));
  }, 0);
}

/**
 * A stored schema version or guard revision as a message may show it. Real
 * ones are small; anything larger could be a tampered value carrying card
 * data, so it shows only as a bound.
 */
const storedNumberLabel = (value: number) =>
  (Number.isSafeInteger(value) && value >= 0 && value < 1000 ? String(value) : '1000 or higher');

/**
 * Refuses a database written by a newer build: a schema version above
 * CURRENT_USER_VERSION, or card guards above this build's revision. Otherwise
 * an older build would run its own migrations against a schema it does not
 * know, replace stronger guards with weaker ones, or write through weaker
 * detectors. Rolling back means restoring a backup made by the older build.
 * The constructor runs this once without a lock to fail fast, and again under
 * the write lock that covers all schema work, which is the check that counts.
 */
function assertSupportedDatabase(db: DB, guards: CardGuardBuild): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > CURRENT_USER_VERSION) {
    throw new HoldrRefusal(
      `database schema v${storedNumberLabel(version)} is newer than this build supports (v${CURRENT_USER_VERSION}); ` +
        'refusing to open it. Run the newer build, or restore a backup made by this one.',
    );
  }
  const revision = storedCardGuardRevision(db);
  if (revision > guards.revision) {
    throw new HoldrRefusal(
      `card guards are revision ${storedNumberLabel(revision)}, newer than this build's ${guards.revision}; ` +
        'refusing to open the database. Run the newer build, or restore a backup made by this one.',
    );
  }
}

/**
 * v13, v14 and v15 upgrades and guard refresh with the version stamp,
 * all-or-nothing. It runs inside the constructor's IMMEDIATE transaction,
 * after assertSupportedDatabase has re-checked the database under the same lock.
 * A fresh database runs the same three steps an upgrade runs, on empty
 * tables, so fresh and upgraded schemas are identical by construction.
 * syncCardGuards re-checks stored rows before it stamps newer guards, and on
 * any schema upgrade the rows of every card table; if any fails, the whole
 * open is refused and nothing is written.
 */
function ensureCardSpendingSchema(db: DB, guards: CardGuardBuild, now: Date): void {
  db.transaction(() => {
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < CARD_SPENDING_VERSION) db.exec(CARD_SCHEMA_SQL);
    if (version < CARD_REPORTS_VERSION) db.exec(CARD_REPORTS_SCHEMA_SQL);
    if (version < CARD_SYNC_VERSION) migrateCardSyncSchema(db, now.toISOString());
    // Later card migrations belong here, before the guards are regenerated.
    syncCardGuards(db, guards, { upgrading: version < CURRENT_USER_VERSION });
    if (version < CURRENT_USER_VERSION) db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
  })();
}

/**
 * Lightweight ALTER-based upgrade for DBs created before `created_at` /
 * `updated_at` columns existed.
 *
 * Naive `ALTER TABLE ADD COLUMN ... DEFAULT ''` is a foot-gun: it keeps the
 * empty-string default in place forever, so future inserts that don't pass
 * the column explicitly produce blank timestamps. We fix this by rebuilding
 * the affected table inside a transaction so the resulting schema is
 * byte-identical to a fresh CREATE TABLE.
 *
 * Idempotent: detects the columns and only rebuilds when they're missing.
 */
function ensureTimestampColumns(db: DB): void {
  const tableHas = (table: string, col: string): boolean => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === col);
  };

  // Pair the rebuild target with its post-rebuild CREATE statement (must
  // match the canonical SCHEMA_SQL above).
  const tables: Array<{ name: string; createSql: string; columns: string }> = [
    {
      name: 'accounts',
      columns: 'id, name, type, cash_balance, currency, sort_order, account_number',
      createSql: `CREATE TABLE accounts (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        type           TEXT,
        cash_balance   REAL NOT NULL,
        currency       TEXT NOT NULL,
        sort_order     INTEGER NOT NULL,
        account_number TEXT,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
    },
    {
      name: 'transactions',
      columns:
        'id, account_id, symbol, date, quantity, price_per_unit, fees, currency, notes, sort_order',
      createSql: `CREATE TABLE transactions (
        id             TEXT PRIMARY KEY,
        account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        symbol         TEXT NOT NULL,
        date           TEXT NOT NULL,
        quantity       REAL NOT NULL,
        price_per_unit REAL NOT NULL,
        fees           REAL,
        currency       TEXT NOT NULL,
        notes          TEXT,
        sort_order     INTEGER NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
    },
  ];

  for (const t of tables) {
    if (tableHas(t.name, 'created_at') && tableHas(t.name, 'updated_at')) continue;

    // Rebuild the table so the canonical CURRENT_TIMESTAMP-style default is
    // preserved for future inserts. SQLite doesn't allow ALTER COLUMN SET
    // DEFAULT, so the only way to get a clean default is to recreate.
    const tx = db.transaction(() => {
      db.exec(`ALTER TABLE ${t.name} RENAME TO ${t.name}__legacy;`);
      db.exec(t.createSql + ';');
      db.exec(
        `INSERT INTO ${t.name} (${t.columns}, created_at, updated_at) ` +
          `SELECT ${t.columns}, ` +
          `strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ` +
          `FROM ${t.name}__legacy;`,
      );
      db.exec(`DROP TABLE ${t.name}__legacy;`);
    });
    tx();
  }

  // Recreate the index that lived on the old table (now dropped via rebuild).
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);');
}

/**
 * v6 migration: nullable `account_number` column on `accounts`. Used by the
 * broker importer to deterministically match a Fidelity / Schwab section
 * label like "ROTH IRA ***6741" against an existing account. Safe to run
 * on databases that already have the column.
 *
 * `ALTER TABLE ... ADD COLUMN ... TEXT` (no DEFAULT) is always idempotent
 * and zero-cost in SQLite — the column is added with NULL for every
 * existing row. No table rewrite is needed because this migration adds a
 * nullable column with no default expression.
 */
function ensureAccountNumberColumn(db: DB): void {
  const rows = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === 'account_number')) return;
  db.exec('ALTER TABLE accounts ADD COLUMN account_number TEXT');
}

/**
 * v7 migration: nullable `source_fingerprint` column on `transactions` and a
 * partial unique index on `(account_id, source_fingerprint)`. Used by the
 * broker-activity importer (POST /import/activity-from-broker) to make
 * re-running a sync idempotent — if a row's fingerprint already exists for
 * that account, the new row is skipped.
 *
 * The unique index is partial (`WHERE source_fingerprint IS NOT NULL`) so
 * legacy rows (manual entries, snapshot imports) never collide with each
 * other and remain freely insertable. SQLite supports partial unique
 * indexes natively.
 */
function ensureSourceFingerprintColumn(db: DB): void {
  const rows = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === 'source_fingerprint')) {
    db.exec('ALTER TABLE transactions ADD COLUMN source_fingerprint TEXT');
  }
  // Index creation is idempotent — safe on every boot.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_source_fingerprint
       ON transactions(account_id, source_fingerprint)
       WHERE source_fingerprint IS NOT NULL`,
  );
}

/**
 * `local_sessions.secure` for databases whose session table was created
 * before it existed. Old rows count as plain-HTTP sessions (secure = 0).
 */
function ensureLocalSessionSecureColumn(db: DB): void {
  const rows = db.prepare('PRAGMA table_info(local_sessions)').all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === 'secure')) return;
  db.exec('ALTER TABLE local_sessions ADD COLUMN secure INTEGER NOT NULL DEFAULT 0 CHECK (secure IN (0, 1))');
}

function ensureOptionColumns(db: DB): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!columns.has('instrument_type')) {
    db.exec('ALTER TABLE transactions ADD COLUMN instrument_type TEXT');
  }
  if (!columns.has('contract_multiplier')) {
    db.exec('ALTER TABLE transactions ADD COLUMN contract_multiplier INTEGER');
  }
  if (!columns.has('position_effect')) {
    db.exec('ALTER TABLE transactions ADD COLUMN position_effect TEXT');
  }
}

function backfillHistoryInvalidations(db: DB): void {
  db.exec(`
    INSERT OR IGNORE INTO account_history_invalidations
      (account_id, effective_date, detected_at, reason)
    SELECT account_id, event_date, imported_at,
           'cash event ' || id || ' was recorded after its effective date'
      FROM account_cash_events AS event
     WHERE imported_at <> ''
       AND EXISTS (
         SELECT 1
           FROM account_snapshots AS snapshot
          WHERE snapshot.account_id = event.account_id
            AND substr(snapshot.taken_at, 1, 10) >= event.event_date
            AND snapshot.taken_at < event.imported_at
       );
  `);
}

function marketDateFor(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to determine market date');
  return `${year}-${month}-${day}`;
}

export interface SqliteStateRepoOptions {
  /** File path or `:memory:`. */
  file: string;
  /** Injectable clock for deterministic history-invalidation tests. */
  now?: () => Date;
  /**
   * Card guard identity, detectors included. Only tests that simulate another
   * build override it.
   */
  cardGuards?: CardGuardBuild;
  /** The benefits catalog the Benefits tab and its marks use; tests substitute a synthetic one. */
  benefitsCatalog?: BenefitCatalog;
}

interface TransactionRow {
  id: string;
  account_id: string;
  symbol: string;
  date: string;
  quantity: number;
  price_per_unit: number;
  instrument_type: string | null;
  contract_multiplier: number | null;
  position_effect: string | null;
  fees: number | null;
  currency: string;
  notes: string | null;
  source_fingerprint: string | null;
}

function mapTransactionRow(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.account_id,
    symbol: row.symbol,
    date: row.date,
    quantity: row.quantity,
    pricePerUnit: row.price_per_unit,
    ...(row.instrument_type === 'option'
      ? {
          instrumentType: 'option' as const,
          contractMultiplier: row.contract_multiplier ?? undefined,
          positionEffect: row.position_effect === 'open' || row.position_effect === 'close'
            ? row.position_effect
            : undefined,
        }
      : {}),
    fees: row.fees ?? undefined,
    currency: row.currency,
    notes: row.notes ?? undefined,
    sourceFingerprint: row.source_fingerprint ?? undefined,
  };
}

export interface AccountNavObservationInput {
  id: string;
  accountId: string;
  broker: string;
  observedAt: string;
  nav: number;
  currency: string;
  statementPeriodStart: string;
  statementPeriodEnd: string;
  accountLast4: string;
  sourceDocumentHash: string;
  sourceFileName?: string;
  sourcePage: number;
}

export interface AccountNavObservation extends AccountNavObservationInput {
  importedAt: string;
}

export interface CashHistoryImportInput {
  accountId: string;
  currency: string;
  broker: string;
  accountLast4: string;
  /** sha256 of the source export(s) the balances were rebuilt from. */
  sourceHash: string;
  /** How the balances were derived, e.g. `fidelity-activity-eod-v1`. */
  method: string;
  rows: Array<{ date: string; cashBalance: number }>;
}

export interface CashHistoryRow {
  accountId: string;
  date: string;
  cashBalance: number;
  currency: string;
  broker: string;
  accountLast4: string;
  sourceHash: string;
  method: string;
  importedAt: string;
}

export interface CashHistoryImportResult {
  inserted: number;
  unchanged: number;
  conflicts: Array<{ date: string; existing: number; incoming: number }>;
}

export interface CardAccountInput {
  /** Lowercase issuer slug, e.g. `amex`. */
  issuer: string;
  owner: CardOwner;
  nickname?: string;
  /** Exactly four digits as the issuer shows them; never padded. */
  last4?: string;
  /** Five trailing digits where the issuer shows five (American Express); must end with `last4`, which it implies. */
  last5?: string;
  currency: string;
  /** Defaults to `active`. */
  status?: CardAccountStatus;
}

export interface CardAccountPatch {
  nickname?: string | null;
  status?: CardAccountStatus;
  /** Add (or clear) the five-digit ending of an account whose last four digits are known. */
  last5?: string | null;
}

/** One row of a redacted export. The issuer's reference arrives only as its `cardExternalIdHash`. */
export interface CardImportRow {
  externalIdHash?: string | null;
  transactionDate: string;
  postedDate?: string | null;
  status: CardTransactionStatus;
  /** Integer minor units: positive = money spent, negative = refund, payment or cashback. */
  amountMinor: number;
  /** Must equal the card account's currency. */
  currency: string;
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  kind: CardTransactionKind;
  description: string;
  merchant?: string | null;
  issuerCategory?: string | null;
}

/** getCardSyncOwnerSet's read found a first page that needs a refresh first. */
const STALE_FIRST_PAGE = Symbol('stale first page');

/** The owner's answers to a v1 import's questions, as the route reads them from its query (Phase 4, #22). */
export interface CardImportDecisions {
  possibleDuplicates?: 'skip' | 'import';
  pendingMatches?: 'post' | 'skip' | 'split' | 'import';
  dismissedMatches?: 'post' | 'keep';
  stalePending?: 'dismiss' | 'keep';
  acceptMismatch?: boolean;
}

/**
 * The complete lists the route computed and showed in this request
 * (never a response's lists, which stop at 100 rows): the commit asks again
 * when the rows its own transaction finds differ.
 */
export interface CardImportShown {
  possibleDuplicateRows: readonly number[];
  pendingMatchRows: readonly number[];
  dismissedMatchRows: readonly number[];
  stalePendingIds: readonly string[];
}

/** `commitCardImport`'s input: the validated payload and the owner's decisions (E1b design §4.10.4, §5.7). */
export interface CardImportCommitInput {
  cardAccountId: string;
  payload: CardImportPayload;
  decisions: CardImportDecisions;
  shown: CardImportShown;
  /** The `previewDigest` of the preview the client saw, when it echoes it. */
  previewDigest?: string;
  actorRef?: string;
}

/**
 * A v1 import's classification (§5.7, §4.10.4): Phase 4's plan, the rows the
 * import holds or reviews (E2d), the statement check, and the digest of it
 * all. `previewCardImport` answers it; the commit computes it again inside
 * its own transaction.
 */
export interface CardImportPreview {
  plan: ImportPlan;
  /**
   * Rows held for review, not applied until the owner decides: near rows with sync provenance, or posting a pending row
   * that such a posted row may already be.
   */
  heldRows: number[];
  /** Rows that would be held but are under review already (a live set asks about them): nothing new. */
  heldOpenRows: number[];
  /** Duplicates the owner is asked about (E-Q7, a detached key, another key's other values): one item each; the ledger is untouched. */
  reviewRows: number[];
  /** Rows that post their pending row by reference: one per pending row, none held (the owner's matches wait for the answer). */
  promotedRows: number[];
  reconciliation: CardImportReconciliation;
  previewDigest: string;
}

/** What a commit needs the owner to decide first (the route's 409s). */
export type CardImportDecisionKind = 'preview-stale' | 'statement-mismatch' | 'possible-duplicates' | 'pending-matches'
  | 'pending-match-twins' | 'dismissed-matches' | 'stale-pending';

/** The decided rows of a commit, as Phase 4's route reports them. */
export interface CardImportCommitCounts {
  skippedPossibleDuplicates: number;
  /** Pending rows posted: by their reference, on the owner's word (post or split) and dismissed rows posted again. */
  pendingPostedCount: number;
  pendingMatchesInsertedCount: number;
  stalePendingDismissedCount: number;
}

/**
 * `decision-required` is returned, never thrown (§5.7): the route answers its
 * 409 with the rows this transaction found. `nothing-new` stores nothing
 * (Phase 4's 200). `imported` stored a batch, its rows and its file sets.
 */
export type CardImportCommitResult =
  | { status: 'decision-required'; kind: CardImportDecisionKind; preview: CardImportPreview }
  | { status: 'nothing-new'; preview: CardImportPreview; counts: CardImportCommitCounts; applied: CardImportApplied }
  | { status: 'imported'; preview: CardImportPreview; counts: CardImportCommitCounts; applied: CardImportApplied; batch: CardImportBatch;
    reviewCount: number; heldCount: number };

/**
 * What a v1 commit did with its rows once the owner's decisions applied, at their positions in the file (E2d review
 * r1, findings 7 and 9): a commit's answer reports these, never its preview's.
 */
export interface CardImportApplied {
  /** Rows held for review: not applied until the owner decides (new items). */
  heldRows: number[];
  /** Rows that would be held but are under review already (duplicates). */
  heldOpenRows: number[];
  /** Duplicates the owner is asked about (new items; the ledger is untouched). */
  reviewRows: number[];
}

/** What one v1 import stored besides its rows (E2d): the batch, and the review work its file sets hold. */
interface CardImportOutcome extends CardImportApplied {
  batchId: string;
  /** Review items stored: rows held and duplicates asked about. */
  reviewCount: number;
  /** Rows held for review instead of applied (counted in the batch's `rejected_count`). */
  heldCount: number;
  /** Rows inserted, pending rows posted, and pending rows dismissed with the import. */
  newCount: number;
  promotedCount: number;
  dismissedCount: number;
  /** Rows inserted on the owner's word that they are other purchases than the pending rows they match. */
  insertedMatchCount: number;
}

export interface CardImportInput {
  cardAccountId: string;
  /** Lowercase slug for the export format, e.g. `amex-csv`. */
  source: string;
  parserVersion: string;
  /** Rows the parser dropped before this import; counted, never stored. */
  rejectedCount?: number;
  /**
   * Each row's position in its v1 file, when some rows of the file were left
   * out (possible duplicates the owner skipped): what review items show as
   * the row's `file_row_index`. Defaults to the rows' order.
   */
  fileRowIndexes?: readonly number[];
  /**
   * The inclusive dates the import speaks for. Every row's posted date (its
   * transaction date when it has none) must fall inside. With a coverage the
   * import may have no rows: it then only records that nothing happened.
   */
  coverage?: { start: string; end: string } | null;
  rows: CardImportRow[];
  /**
   * A posted row whose issuer reference is stored for a pending row posts
   * that row in place. Without a reference the key is a content fingerprint
   * whose occurrence number depends on the rows around it, so a match proves
   * nothing: such a row posts the pending (or dismissed) row only when the
   * owner said so (true); otherwise it is a duplicate, as before.
   */
  promoteFingerprintMatches?: boolean;
  /**
   * A posted row whose issuer reference is stored for a row the owner
   * dismissed is that charge, posted after all, but the dismissal was the
   * owner's decision: it posts again only when the owner says so (true).
   * Otherwise it stays dismissed and the row is a duplicate.
   */
  promoteDismissedMatches?: boolean;
  /**
   * The owner's third answer to a fingerprint match: the posted row is a
   * different purchase from the pending (or dismissed) row whose fingerprint
   * it carries. It is stored as a new posted row under the next fingerprint
   * occurrence that no stored row and no row of this import uses, and the
   * matched row stays as it is. Exclusive with `promoteFingerprintMatches`.
   * (The import route refuses it when a posted row with the same date,
   * amount and description is already stored: the row is then most likely
   * that purchase again, and `skip` is the answer.)
   */
  insertFingerprintMatches?: boolean;
  /**
   * The owner's answer per row instead of one for all
   * (`promoteFingerprintMatches`): the indexes, in `rows`, of the fingerprint
   * matches to post; every other fingerprint match is a duplicate. Each must
   * be a fingerprint match of a pending (or dismissed) row when the import
   * runs; otherwise nothing is written. Exclusive with
   * `promoteFingerprintMatches` and `insertFingerprintMatches`.
   */
  promoteFingerprintMatchRows?: readonly number[];
  /**
   * Pending rows of this card account that the owner dismisses together with
   * this import: those a complete, closed statement leaves out and that the
   * owner says will not post as they are. Each must still be pending when the
   * import runs; otherwise nothing is written.
   */
  dismissPendingIds?: readonly string[];
  /**
   * The signed-in owner who imports (cardSyncActorRef of the session's user),
   * named by the import's ledger events. Without one (the loopback service
   * principal) the events name the system.
   */
  actorRef?: string;
}

/** Who changes a card transaction through the Spending tab: the signed-in owner's cardSyncActorRef. */
export interface CardTransactionChangeContext {
  actorRef: string;
}

export interface CardTransactionFilter {
  cardAccountId?: string;
  /** Inclusive YYYY-MM-DD bounds on the transaction date. */
  from?: string;
  to?: string;
}

export type CardTransactionSort = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc';

/** Filters shared by the transaction list and the spending summary; each one narrows the result. */
export interface CardTransactionQuery {
  cardAccountId?: string;
  owner?: CardOwner;
  /** Defaults to pending and posted. */
  statuses?: readonly CardTransactionStatus[];
  /** Stored kinds. */
  kinds?: readonly CardTransactionKind[];
  /**
   * Kinds as Spending reads them (shared `effectiveCardKind`: a charge that takes a payment to the card back is a
   * payment, whatever kind it was stored with, and a payment that names a fee is what the import classifier makes of it),
   * so a list filtered by kind holds exactly the rows the reports count so.
   */
  spendingKinds?: readonly CardTransactionKind[];
  /** Effective category (custom, else issuer, else `Uncategorized`), exactly. */
  category?: string;
  /**
   * A merchant group: rows whose merchant name (else description) satisfies
   * the shared `matchesCardMerchantGroup` predicate for this key.
   */
  merchant?: string;
  /**
   * Case-insensitive (ASCII) text in the description, merchant, categories or
   * notes. A plain amount such as `12.34` also matches rows of that absolute
   * amount in their own currency.
   */
  search?: string;
  /** Inclusive YYYY-MM-DD bounds on the transaction date. */
  from?: string;
  to?: string;
}

export interface CardTransactionPageRequest {
  /** Defaults to `date-desc`. */
  sort?: CardTransactionSort;
  /** 1 to {@link MAX_CARD_TRANSACTION_PAGE}; defaults to 50. */
  limit?: number;
  offset?: number;
}

export interface CardTransactionPage {
  transactions: CardTransaction[];
  /** Rows matching the query, all pages. */
  total: number;
}

export interface CardTransactionPatch {
  /** A custom category shown and summed instead of the issuer's; null or '' clears it. */
  userCategory?: string | null;
  /** null or '' clears them. */
  notes?: string | null;
  /**
   * `removed` dismisses a pending row; `pending` restores a dismissed one.
   * Nothing else changes status.
   */
  status?: 'pending' | 'removed';
  /**
   * The owner's word that this pending row posted as that posted row (same
   * card account and currency), typically under another issuer reference.
   * The pending row is dismissed and kept, so its dedupe key still answers
   * for it and replaying the export it came from never brings it back; its
   * custom category and notes are copied to the posted row where that row
   * has none. On its own only.
   */
  postedAs?: string;
}

export const MAX_CARD_TRANSACTION_PAGE = 200;

export class SqliteStateRepo {
  private readonly db: DB;
  private readonly now: () => Date;
  private readonly cardDetectors: Readonly<CardDetectors>;
  /** The card-sync named statements (E1b §5.3.1), prepared on first use. */
  private syncStatements?: CardSyncStatements;
  /** The guard revision this build installs, which auto-sync consent snapshots. */
  private readonly guardRevision: number;
  private readonly benefits: BenefitCatalog;

  constructor({ file, now = () => new Date(), cardGuards = CARD_GUARD_BUILD, benefitsCatalog = BENEFITS_CATALOG }: SqliteStateRepoOptions) {
    this.now = now;
    this.cardDetectors = rememberingCleanTexts(cardGuards.detectors);
    this.guardRevision = cardGuards.revision;
    this.benefits = benefitsCatalog;
    let db: DB | undefined;
    try {
      if (file !== ':memory:') {
        // A new data folder is private to this user from the start (an existing one is left as it is).
        ensurePrivateDataDir(path.dirname(file));
      }
      db = new Database(file);
      this.db = db;
      // Fast fail for a database from a newer build. The binding check is the
      // one repeated under the write lock below.
      assertSupportedDatabase(this.db, cardGuards);
      registerCardFunctions(this.db, cardGuards, this.cardDetectors);
      // Merchant grouping in SQL (the `merchant` filter): per connection, never stored in the schema.
      this.db.function('holdr_merchant_key', { deterministic: true }, (value: unknown) =>
        (typeof value === 'string' ? cardMerchantKey(value) : null));
      // The kind Spending reads a row as (the `spendingKinds` filter): per connection, never stored in the schema.
      this.db.function('holdr_card_spending_kind', { deterministic: true }, cardSpendingKindOf);
      // A page cache of up to 64 MiB rather than SQLite's 2 MiB default: a
      // 2,000-row card sync commit dirties more pages than the default holds,
      // and spilling them mid-transaction cost a candidate-heavy commit about
      // 15% (slice 2 review r1, finding 8). A bound, not an allocation; set
      // before the settings below, which the crash tests' hook keys on.
      this.db.pragma('cache_size = -65536');
      // Connection settings; SQLite cannot change either inside a transaction.
      // Holdr databases are already in WAL mode, so this writes only for a new
      // or legacy rollback-journal file.
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.function('holdr_merchant_matches', { deterministic: true }, (key: unknown, group: unknown) =>
        (typeof key === 'string' && typeof group === 'string'
          ? Number(matchesCardMerchantGroup(key, group)) : 0));
      // All schema work runs in one IMMEDIATE transaction. It takes the write
      // lock before re-checking compatibility, so no other connection can
      // upgrade the database between the check and the migrations, and holds
      // it through every migration and the guard refresh. A failure anywhere
      // leaves the database as it was. The helpers' own transactions become
      // savepoints inside it.
      this.db.transaction(() => {
        assertSupportedDatabase(this.db, cardGuards);
        this.db.exec(SCHEMA_SQL);
        // v6 migration first: add account_number column if missing. We do this
        // BEFORE the timestamp rebuild so that the rebuild's column list (which
        // references account_number) sees a column that exists on disk.
        ensureAccountNumberColumn(this.db);
        // Backfill timestamp columns on DBs created by an earlier build.
        ensureTimestampColumns(this.db);
        // v7: optional source_fingerprint column + partial unique index.
        ensureSourceFingerprintColumn(this.db);
        // v10: nullable option metadata; equity rows remain byte-for-byte intact.
        ensureOptionColumns(this.db);
        // Local sign-in: sessions created before the secure flag existed get it (no version bump).
        ensureLocalSessionSecureColumn(this.db);
        // v11: infer late cash imports from their immutable broker-audit timestamps.
        // Legacy transaction timestamps are blank, so those are never guessed.
        backfillHistoryInvalidations(this.db);
        // v13/v14/v15: card spending and card sync tables and guards, and the
        // schema version stamp so future migrations have an anchor point.
        ensureCardSpendingSchema(this.db, cardGuards, this.now());
        // Card benefits: additive tables beside the card tables, created idempotently (no version bump).
        ensureCardBenefitsSchema(this.db);
      }).immediate();
    } catch (error) {
      // Never hand back a half-initialized database handle, nor an error that
      // quotes the database: SQLite's messages can carry whatever it stores.
      try {
        db?.close();
      } catch {
        // The value-free error below is the one to report.
      }
      throw toValueFreeDbError('open database', error);
    }
  }

  /** Returns the schema version currently stamped on this DB. */
  schemaVersion(): number {
    return (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
  }

  /** True iff there is at least one row in `accounts`. */
  isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    return row.n === 0;
  }

  /** Returns the persisted state, or null if the DB is empty. */
  read(): PersistedState | null {
    if (this.isEmpty()) return null;

    const accRows = this.db
      .prepare('SELECT id, name, type, cash_balance, currency, account_number FROM accounts ORDER BY sort_order')
      .all() as Array<{ id: string; name: string; type: string | null; cash_balance: number; currency: string; account_number: string | null }>;

    const txRows = this.db
      .prepare(
        `SELECT id, account_id, symbol, date, quantity, price_per_unit,
                instrument_type, contract_multiplier, position_effect,
                fees, currency, notes, source_fingerprint
         FROM transactions ORDER BY sort_order`,
      )
      .all() as TransactionRow[];

    const accounts: Account[] = accRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type ?? undefined,
      cashBalance: r.cash_balance,
      currency: r.currency,
      accountNumber: r.account_number ?? undefined,
    }));
    const transactions = txRows.map(mapTransactionRow);
    return { accounts, transactions };
  }

  /**
   * Replace the whole stored state. Validation runs first; if it fails we
   * never touch the DB. The replace is wrapped in a transaction so a crash
   * mid-write leaves the DB at the prior consistent state.
   */
  write(state: PersistedState): void {
    const err = validatePersistedState(state);
    if (err) throw new Error(`refusing to write invalid state: ${err}`);

    const insertAccount = this.db.prepare(
      'INSERT INTO accounts (id, name, type, cash_balance, currency, sort_order, account_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertTx = this.db.prepare(
      `INSERT INTO transactions
        (id, account_id, symbol, date, quantity, price_per_unit,
         instrument_type, contract_multiplier, position_effect,
         fees, currency, notes, sort_order, source_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const replace = this.db.transaction((s: PersistedState) => {
      // Order matters: drop transactions first because of the FK.
      this.db.exec('DELETE FROM transactions; DELETE FROM accounts;');
      for (const [i, a] of s.accounts.entries()) {
        insertAccount.run(a.id, a.name, a.type ?? null, a.cashBalance, a.currency, i, a.accountNumber ?? null);
      }
      for (const [i, t] of s.transactions.entries()) {
        insertTx.run(
          t.id,
          t.accountId,
          t.symbol,
          t.date,
          t.quantity,
          t.pricePerUnit,
          t.instrumentType ?? null,
          t.contractMultiplier ?? null,
          t.positionEffect ?? null,
          t.fees ?? null,
          t.currency,
          t.notes ?? null,
          i,
          t.sourceFingerprint ?? null,
        );
      }
    });
    replace(state);
  }

  // -------------------------------------------------------------------------
  // Fine-grained CRUD (Phase 3 — per-resource API)
  // -------------------------------------------------------------------------

  listAccounts(): Account[] {
    const rows = this.db
      .prepare('SELECT id, name, type, cash_balance, currency, account_number FROM accounts ORDER BY sort_order')
      .all() as Array<{ id: string; name: string; type: string | null; cash_balance: number; currency: string; account_number: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type ?? undefined,
      cashBalance: r.cash_balance,
      currency: r.currency,
      accountNumber: r.account_number ?? undefined,
    }));
  }

  getAccount(id: string): Account | null {
    const r = this.db
      .prepare('SELECT id, name, type, cash_balance, currency, account_number FROM accounts WHERE id = ?')
      .get(id) as { id: string; name: string; type: string | null; cash_balance: number; currency: string; account_number: string | null } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      type: r.type ?? undefined,
      cashBalance: r.cash_balance,
      currency: r.currency,
      accountNumber: r.account_number ?? undefined,
    };
  }

  createAccount(input: Account): Account {
    const next = (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM accounts').get() as { n: number }).n;
    this.db
      .prepare(
        'INSERT INTO accounts (id, name, type, cash_balance, currency, sort_order, account_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.name,
        input.type ?? null,
        input.cashBalance,
        input.currency,
        next,
        input.accountNumber ?? null,
      );
    return input;
  }

  updateAccount(
    id: string,
    patch: Partial<Pick<Account, 'name' | 'type' | 'cashBalance' | 'currency' | 'accountNumber'>>,
  ): Account | null {
    const existing = this.getAccount(id);
    if (!existing) return null;
    const merged: Account = {
      ...existing,
      ...patch,
      type: patch.type !== undefined ? patch.type : existing.type,
      accountNumber:
        patch.accountNumber !== undefined ? patch.accountNumber : existing.accountNumber,
    };
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE accounts SET name = ?, type = ?, cash_balance = ?, currency = ?,
           account_number = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
        .run(
          merged.name,
          merged.type ?? null,
          merged.cashBalance,
          merged.currency,
          merged.accountNumber ?? null,
          id,
        );
      if (merged.cashBalance !== existing.cashBalance) {
        this.recordHistoryInvalidation(
          id,
          marketDateFor(this.now()),
          'cash balance was corrected after snapshots were captured',
        );
      }
    });
    update();
    return merged;
  }

  /**
   * Hard-delete an account. Refuses if financial records reference it
   * (FKs are RESTRICT, but we surface a clean error instead of an FK message).
   * Returns false if the account did not exist.
   */
  deleteAccount(id: string): { deleted: boolean; reason?: string } {
    const existing = this.getAccount(id);
    if (!existing) return { deleted: false, reason: 'not found' };
    const txCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(id) as { n: number }
    ).n;
    if (txCount > 0) {
      return { deleted: false, reason: `account has ${txCount} transaction(s); remove them first` };
    }
    const snapshotCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM account_snapshots WHERE account_id = ?').get(id) as { n: number }
    ).n;
    if (snapshotCount > 0) {
      return { deleted: false, reason: `account has ${snapshotCount} portfolio snapshot(s); remove them first` };
    }
    const navCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM account_nav_history WHERE account_id = ?').get(id) as { n: number }
    ).n;
    if (navCount > 0) {
      return { deleted: false, reason: `account has ${navCount} broker NAV history observation(s); remove them first` };
    }
    const cashEventCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM account_cash_events WHERE account_id = ?').get(id) as { n: number }
    ).n;
    if (cashEventCount > 0) {
      return { deleted: false, reason: `account has ${cashEventCount} cash event(s); remove them first` };
    }
    const cashHistoryCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM account_cash_history WHERE account_id = ?').get(id) as { n: number }
    ).n;
    if (cashHistoryCount > 0) {
      return { deleted: false, reason: `account has ${cashHistoryCount} cash history row(s); remove them first` };
    }
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM account_history_invalidations WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
    remove();
    return { deleted: true };
  }

  listTransactions(accountId?: string): Transaction[] {
    const rows = (accountId
      ? this.db
          .prepare(
            `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency, notes, source_fingerprint
                  , instrument_type, contract_multiplier, position_effect
             FROM transactions WHERE account_id = ? ORDER BY sort_order`,
          )
          .all(accountId)
      : this.db
          .prepare(
            `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency, notes, source_fingerprint
                  , instrument_type, contract_multiplier, position_effect
             FROM transactions ORDER BY sort_order`,
          )
          .all()) as TransactionRow[];
    return rows.map(mapTransactionRow);
  }

  createTransaction(input: Transaction): Transaction {
    if (!this.getAccount(input.accountId)) {
      throw new Error('account does not exist');
    }
    const next = (
      this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM transactions').get() as { n: number }
    ).n;
    const tx = this.db.transaction((row: Transaction) => {
      this.db
        .prepare(
          `INSERT INTO transactions
            (id, account_id, symbol, date, quantity, price_per_unit,
             instrument_type, contract_multiplier, position_effect,
             fees, currency, notes, sort_order, source_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.accountId,
          row.symbol,
          row.date,
          row.quantity,
          row.pricePerUnit,
          row.instrumentType ?? null,
          row.contractMultiplier ?? null,
          row.positionEffect ?? null,
          row.fees ?? null,
          row.currency,
          row.notes ?? null,
          next,
          row.sourceFingerprint ?? null,
        );
      // When committing a NEW activity row (sha256-hex fingerprint, not a
      // `pos:` snapshot), evict any legacy "imported" snapshot rows for the
      // same (account, symbol). This is the write-time half of the
      // double-count fix — the read-time guard in
      // `dropImportedSnapshotsWhereActivityExists` already protects display,
      // but evicting at write time keeps the DB tidy and idempotent: once
      // any activity for a (account, symbol) lands, the legacy snapshot is
      // gone forever and re-pulls cannot re-introduce the dupe.
      const fp = row.sourceFingerprint;
      if (fp && !fp.startsWith('pos:')) {
        this.db
          .prepare(
            `DELETE FROM transactions
             WHERE account_id = ?
               AND symbol = ?
               AND source_fingerprint IS NULL
               AND notes IS NOT NULL
               AND notes LIKE 'imported%'`,
          )
          .run(row.accountId, row.symbol);
      }
      this.recordHistoryInvalidation(row.accountId, row.date, `transaction ${row.id} was recorded after its effective date`);
    });
    tx(input);
    return input;
  }

  private recordHistoryInvalidation(accountId: string, effectiveDate: string, reason: string): void {
    const detectedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO account_history_invalidations
          (account_id, effective_date, detected_at, reason)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM account_snapshots
             WHERE account_id = ? AND taken_at < ?
          )
         ON CONFLICT(account_id, effective_date, detected_at, reason) DO NOTHING`,
      )
      .run(accountId, effectiveDate, detectedAt, reason, accountId, detectedAt);
  }

  /**
   * Look up a transaction by its (account, source_fingerprint) pair. Used
   * by the broker-activity importer for dedup: before inserting a new row
   * we ask whether one with the same fingerprint already lives in the
   * target account. Returns null when no match (or when the input
   * fingerprint is empty/nullish, because we do not allow matching on the
   * absence of a fingerprint).
   */
  findTransactionByFingerprint(accountId: string, fingerprint: string | null | undefined): Transaction | null {
    if (!fingerprint) return null;
    const r = this.db
      .prepare(
        `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency, notes, source_fingerprint
          , instrument_type, contract_multiplier, position_effect
         FROM transactions
         WHERE account_id = ? AND source_fingerprint = ?
         LIMIT 1`,
      )
      .get(accountId, fingerprint) as TransactionRow | undefined;
    if (!r) return null;
    return mapTransactionRow(r);
  }

  updateTransaction(
    id: string,
    patch: Partial<Pick<Transaction, 'quantity' | 'pricePerUnit' | 'fees' | 'notes'>>,
  ): Transaction | null {
    const r = this.db
      .prepare(
        `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency, notes, source_fingerprint
          , instrument_type, contract_multiplier, position_effect
         FROM transactions WHERE id = ?`,
      )
      .get(id) as TransactionRow | undefined;
    if (!r) return null;
    const updated: Transaction = {
      id: r.id,
      accountId: r.account_id,
      symbol: r.symbol,
      date: r.date,
      quantity: patch.quantity ?? r.quantity,
      pricePerUnit: patch.pricePerUnit ?? r.price_per_unit,
      ...(r.instrument_type === 'option'
        ? {
            instrumentType: 'option' as const,
            contractMultiplier: r.contract_multiplier ?? undefined,
            positionEffect: r.position_effect === 'open' || r.position_effect === 'close'
              ? r.position_effect
              : undefined,
          }
        : {}),
      fees: patch.fees !== undefined ? patch.fees : (r.fees ?? undefined),
      currency: r.currency,
      notes: patch.notes !== undefined ? patch.notes : (r.notes ?? undefined),
      sourceFingerprint: r.source_fingerprint ?? undefined,
    };
    const affectsHistory = updated.quantity !== r.quantity
      || updated.pricePerUnit !== r.price_per_unit
      || (updated.fees ?? null) !== (r.fees ?? null);
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE transactions
           SET quantity = ?, price_per_unit = ?, fees = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(
          updated.quantity,
          updated.pricePerUnit,
          updated.fees ?? null,
          updated.notes ?? null,
          id,
        );
      if (affectsHistory) {
        this.recordHistoryInvalidation(updated.accountId, updated.date, `transaction ${id} was corrected after snapshots were captured`);
      }
    });
    update();
    return updated;
  }

  getCostBasisCheck(id: string): CostBasisCheck | null {
    const tx = this.db
      .prepare(
        `SELECT id, symbol, date, price_per_unit
         FROM transactions WHERE id = ?`,
      )
      .get(id) as { id: string; symbol: string; date: string; price_per_unit: number } | undefined;
    if (!tx) return null;
    const bar = this.db
      .prepare(
        `SELECT t, close
         FROM symbol_price_bars
         WHERE symbol = ? AND range_kind = 'daily'
         ORDER BY ABS(julianday(t) - julianday(?)) ASC, t DESC
         LIMIT 1`,
      )
      .get(tx.symbol, tx.date) as { t: string; close: number } | undefined;
    if (!bar || bar.close <= 0) {
      return {
        transactionId: tx.id,
        symbol: tx.symbol,
        date: tx.date,
        enteredPrice: tx.price_per_unit,
        historicalPrice: null,
        deviationPercent: null,
        warningLevel: 'unknown',
        reason: 'No cached historical price for this transaction date.',
      };
    }
    const deviationPercent = ((tx.price_per_unit - bar.close) / bar.close) * 100;
    const absDeviation = Math.abs(deviationPercent);
    const warningLevel = absDeviation >= 10 ? 'major' : absDeviation >= 5 ? 'minor' : 'none';
    return {
      transactionId: tx.id,
      symbol: tx.symbol,
      date: tx.date,
      enteredPrice: tx.price_per_unit,
      historicalPrice: bar.close,
      historicalDate: bar.t,
      deviationPercent,
      warningLevel,
      ...(warningLevel === 'none' ? {} : { reason: 'Entered price differs from cached historical close.' }),
    };
  }

  deleteTransaction(id: string): boolean {
    const existing = this.db
      .prepare('SELECT account_id, date FROM transactions WHERE id = ?')
      .get(id) as { account_id: string; date: string } | undefined;
    if (!existing) return false;
    const remove = this.db.transaction(() => {
      const info = this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      if (info.changes > 0) {
        this.recordHistoryInvalidation(existing.account_id, existing.date, `transaction ${id} was deleted after snapshots were captured`);
      }
      return info.changes > 0;
    });
    return remove();
  }

  /**
   * Replace every snapshot-tagged transaction in `accountId` with the
   * supplied list, in one DB transaction.
   *
   * Used by the broker-positions importer ("Pull positions"), which is
   * snapshot semantics: the broker hands us the current holdings, and
   * a re-pull should overwrite whatever the previous pull stamped.
   * Without this, every re-pull would either duplicate rows (if
   * fingerprints differ) or fail with a UNIQUE-constraint error on the
   * partial index over `(account_id, source_fingerprint)`.
   *
   * "Snapshot-tagged" rows are deleted in two passes:
   *   1. Modern: `source_fingerprint LIKE 'pos:%'` (current importer).
   *   2. Legacy: `source_fingerprint IS NULL AND notes LIKE 'imported%'`
   *      (the original screenshot-paste importer wrote rows with notes
   *      like "imported from broker screenshot 2026-05-04" and no
   *      fingerprint). Without this pass, a re-pull would leave those
   *      legacy rows in place so the symbol's quantity gets double-counted
   *      by `aggregatePositions` (the read-time
   *      `dropImportedSnapshotsWhereActivityExists` guard only fires when
   *      activity rows exist for the same symbol — two snapshot rows alone
   *      slip past it).
   *
   * Activity-import fingerprints are sha256 hex (no colon) so the `pos:`
   * prefix is unambiguous. Manual entries with no fingerprint are left
   * alone unless their notes start with "imported" — important so the
   * user's hand-curated history is never deleted by a positions sync.
   * The "imported%" notes prefix is system-generated by the legacy
   * importer in [importMapper.ts](apps/api/src/services/importMapper.ts);
   * users who type free-form notes don't naturally start them that way.
   *
   * Returns `{ deleted, inserted }` for caller-side logging / UI.
   * `deleted` covers both passes combined.
   */
  replaceSnapshotPositions(accountId: string, txs: Transaction[]): { deleted: number; inserted: number } {
    if (!this.getAccount(accountId)) {
      throw new Error('account does not exist');
    }
    // Reject any cross-account input up front so we cannot accidentally
    // delete one account's snapshot and write rows into another.
    for (const t of txs) {
      if (t.accountId !== accountId) {
        throw new Error('replaceSnapshotPositions: every transaction must belong to the account');
      }
      if (!t.sourceFingerprint || !t.sourceFingerprint.startsWith('pos:')) {
        throw new Error("replaceSnapshotPositions: every transaction must have sourceFingerprint starting with 'pos:'");
      }
    }
    const tx = this.db.transaction((rows: Transaction[]) => {
      const delModern = this.db
        .prepare(`DELETE FROM transactions WHERE account_id = ? AND source_fingerprint LIKE 'pos:%'`)
        .run(accountId);
      const delLegacy = this.db
        .prepare(
          `DELETE FROM transactions
           WHERE account_id = ?
             AND source_fingerprint IS NULL
             AND notes IS NOT NULL
             AND notes LIKE 'imported%'`,
        )
        .run(accountId);
      const baseSort = (
        this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM transactions').get() as { n: number }
      ).n;
      const insStmt = this.db.prepare(
        `INSERT INTO transactions
          (id, account_id, symbol, date, quantity, price_per_unit,
           instrument_type, contract_multiplier, position_effect,
           fees, currency, notes, sort_order, source_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let i = 0;
      for (const r of rows) {
        insStmt.run(
          r.id,
          r.accountId,
          r.symbol,
          r.date,
          r.quantity,
          r.pricePerUnit,
          r.instrumentType ?? null,
          r.contractMultiplier ?? null,
          r.positionEffect ?? null,
          r.fees ?? null,
          r.currency,
          r.notes ?? null,
          baseSort + i,
          r.sourceFingerprint!,
        );
        i += 1;
      }
      this.recordHistoryInvalidation(
        accountId,
        marketDateFor(this.now()),
        'broker position snapshot replaced the prior ledger after snapshots were captured',
      );
      return { deleted: delModern.changes + delLegacy.changes, inserted: rows.length };
    });
    return tx(txs);
  }

  insertAccountNavObservation(
    input: AccountNavObservationInput,
  ): { inserted: boolean; observation: AccountNavObservation } {
    validateAccountNavObservation(input);
    if (!this.getAccount(input.accountId)) {
      throw new Error('account does not exist');
    }
    const info = this.db
      .prepare(
        `INSERT INTO account_nav_history
          (id, account_id, broker, observed_at, nav, currency,
           statement_period_start, statement_period_end, account_last4,
           source_document_hash, source_file_name, source_page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, observed_at, source_document_hash) DO NOTHING`,
      )
      .run(
        input.id,
        input.accountId,
        input.broker,
        input.observedAt,
        input.nav,
        input.currency,
        input.statementPeriodStart,
        input.statementPeriodEnd,
        input.accountLast4,
        input.sourceDocumentHash,
        input.sourceFileName ?? null,
        input.sourcePage,
      );
    const row = this.db
      .prepare(
        `SELECT id, account_id, broker, observed_at, nav, currency,
                statement_period_start, statement_period_end, account_last4,
                source_document_hash, source_file_name, source_page, imported_at
         FROM account_nav_history
         WHERE account_id = ? AND observed_at = ? AND source_document_hash = ?`,
      )
      .get(input.accountId, input.observedAt, input.sourceDocumentHash) as AccountNavRow | undefined;
    if (!row) {
      throw new Error('account NAV observation was not stored');
    }
    return { inserted: info.changes > 0, observation: mapAccountNavRow(row) };
  }

  listAccountNavHistory(accountId: string, from?: string, to?: string): AccountNavObservation[] {
    const conditions = ['account_id = ?'];
    const params: string[] = [accountId];
    if (from) {
      conditions.push('observed_at >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('observed_at <= ?');
      params.push(to);
    }
    const rows = this.db
      .prepare(
        `SELECT id, account_id, broker, observed_at, nav, currency,
                statement_period_start, statement_period_end, account_last4,
                source_document_hash, source_file_name, source_page, imported_at
         FROM account_nav_history
         WHERE ${conditions.join(' AND ')}
         ORDER BY observed_at, imported_at, id`,
      )
      .all(...params) as AccountNavRow[];
    return rows.map(mapAccountNavRow);
  }

  insertCashEvent(input: CashEventInput): { inserted: boolean; event: CashEvent } {
    validateCashEvent(input);
    if (!this.getAccount(input.accountId)) {
      throw new Error('account does not exist');
    }
    const id = cashEventId(input.accountId, input.sourceFingerprint);
    const insert = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO account_cash_events
            (id, account_id, event_date, event_type, amount, currency, broker,
             account_last4, description, source_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, source_fingerprint) DO NOTHING`,
        )
        .run(
          id,
          input.accountId,
          input.date,
          input.eventType,
          input.amount,
          input.currency,
          input.broker,
          input.accountLast4,
          input.description,
          input.sourceFingerprint,
        );
      if (info.changes > 0) {
        this.recordHistoryInvalidation(input.accountId, input.date, `cash event ${id} was recorded after its effective date`);
      }
      return info;
    });
    const info = insert();
    const event = this.findCashEventByFingerprint(input.accountId, input.sourceFingerprint);
    if (!event) throw new Error('cash event was not stored');
    return { inserted: info.changes > 0, event };
  }

  findCashEventByFingerprint(accountId: string, fingerprint: string | null | undefined): CashEvent | null {
    if (!fingerprint) return null;
    const row = this.db
      .prepare(
        `SELECT id, account_id, event_date, event_type, amount, currency, broker,
                account_last4, description, source_fingerprint, imported_at
         FROM account_cash_events
         WHERE account_id = ? AND source_fingerprint = ?
         LIMIT 1`,
      )
      .get(accountId, fingerprint) as CashEventRow | undefined;
    return row ? mapCashEventRow(row) : null;
  }

  listCashEvents(accountId: string, from?: string, to?: string): CashEvent[] {
    const conditions = ['account_id = ?'];
    const params: string[] = [accountId];
    if (from) {
      if (!isValidIsoDate(from)) throw new Error('cash event from date must be valid YYYY-MM-DD');
      conditions.push('event_date >= ?');
      params.push(from);
    }
    if (to) {
      if (!isValidIsoDate(to)) throw new Error('cash event to date must be valid YYYY-MM-DD');
      conditions.push('event_date <= ?');
      params.push(to);
    }
    if (from && to && from > to) throw new Error('cash event from date must not be after to date');
    const rows = this.db
      .prepare(
        `SELECT id, account_id, event_date, event_type, amount, currency, broker,
                account_last4, description, source_fingerprint, imported_at
         FROM account_cash_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY event_date, imported_at, id`,
      )
      .all(...params) as CashEventRow[];
    return rows.map(mapCashEventRow);
  }

  listAllCashEvents(): CashEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, event_date, event_type, amount, currency, broker,
                account_last4, description, source_fingerprint, imported_at
         FROM account_cash_events
         ORDER BY event_date DESC, imported_at DESC, id DESC`,
      )
      .all() as CashEventRow[];
    return rows.map(mapCashEventRow);
  }

  deleteCashEvent(id: string): boolean {
    const existing = this.db
      .prepare('SELECT account_id, event_date FROM account_cash_events WHERE id = ?')
      .get(id) as { account_id: string; event_date: string } | undefined;
    if (!existing) return false;
    const remove = this.db.transaction(() => {
      const info = this.db.prepare('DELETE FROM account_cash_events WHERE id = ?').run(id);
      if (info.changes > 0) {
        this.recordHistoryInvalidation(existing.account_id, existing.event_date, `cash event ${id} was deleted after snapshots were captured`);
      }
      return info.changes > 0;
    });
    return remove();
  }

  /**
   * Store broker end-of-day cash balances atomically. Identical rows are
   * no-ops; any row whose balance differs from the stored one aborts the
   * whole import and is reported, so a correction is always explicit.
   */
  importCashHistory(input: CashHistoryImportInput): CashHistoryImportResult {
    validateCashHistoryImport(input, newYorkDate(this.now()));
    const account = this.getAccount(input.accountId);
    if (!account) throw new Error('account does not exist');
    if (account.currency !== input.currency) {
      throw new Error('cash history currency does not match the account currency');
    }
    const select = this.db.prepare(
      'SELECT cash_balance FROM account_cash_history WHERE account_id = ? AND as_of_date = ?',
    );
    const insert = this.db.prepare(
      `INSERT INTO account_cash_history
         (account_id, as_of_date, cash_balance, currency, broker, account_last4, source_hash, method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((): CashHistoryImportResult => {
      const result: CashHistoryImportResult = { inserted: 0, unchanged: 0, conflicts: [] };
      for (const row of input.rows) {
        const cashBalance = roundCents(row.cashBalance);
        const existing = select.get(input.accountId, row.date) as { cash_balance: number } | undefined;
        if (existing) {
          if (Math.abs(existing.cash_balance - cashBalance) < 0.005) result.unchanged++;
          else result.conflicts.push({ date: row.date, existing: existing.cash_balance, incoming: cashBalance });
          continue;
        }
        insert.run(
          input.accountId, row.date, cashBalance, input.currency, input.broker,
          input.accountLast4, input.sourceHash, input.method,
        );
        result.inserted++;
      }
      if (result.conflicts.length > 0) throw new CashHistoryConflict(result);
      return result;
    });
    try {
      return run();
    } catch (error) {
      if (error instanceof CashHistoryConflict) {
        return { inserted: 0, unchanged: error.result.unchanged, conflicts: error.result.conflicts };
      }
      throw error;
    }
  }

  listCashHistory(accountId: string): CashHistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT account_id, as_of_date, cash_balance, currency, broker, account_last4,
                source_hash, method, imported_at
         FROM account_cash_history WHERE account_id = ? ORDER BY as_of_date`,
      )
      .all(accountId) as CashHistoryDbRow[];
    return rows.map((row) => ({
      accountId: row.account_id,
      date: row.as_of_date,
      cashBalance: row.cash_balance,
      currency: row.currency,
      broker: row.broker,
      accountLast4: row.account_last4,
      sourceHash: row.source_hash,
      method: row.method,
      importedAt: row.imported_at,
    }));
  }

  deleteCashHistory(accountId: string): number {
    return this.db.prepare('DELETE FROM account_cash_history WHERE account_id = ?').run(accountId).changes;
  }

  // -------------------------------------------------------------------------
  // Card spending (v13). Independent of the brokerage ledger: these methods
  // never read or write accounts, transactions, cash events, cash history,
  // snapshots or history invalidations. Errors name fields, never values, and
  // each method runs behind the value-free boundary (CARD_REPO_OPERATIONS).
  // -------------------------------------------------------------------------

  /** A new card account with its legacy card scope (v15), in one transaction. */
  createCardAccount(input: CardAccountInput): CardAccount {
    const account = validateCardAccountInput(input, this.cardDetectors);
    const id = newCardId('card-acct');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO card_accounts (id, issuer, owner, nickname, last4, last5, currency, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, account.issuer, account.owner, account.nickname ?? null, account.last4 ?? null, account.last5 ?? null,
          account.currency, account.status,
        );
      new CardLedgerWriter(this.db, this.now().toISOString()).createLegacyScope(id);
    }).immediate();
    return this.getCardAccount(id)!;
  }

  getCardAccount(id: string): CardAccount | null {
    const row = this.db
      .prepare(`SELECT ${CARD_ACCOUNT_COLUMNS} FROM card_accounts WHERE id = ?`)
      .get(id) as CardAccountRow | undefined;
    return row ? mapCardAccountRow(row) : null;
  }

  listCardAccounts(): CardAccount[] {
    const rows = this.db
      .prepare(`SELECT ${CARD_ACCOUNT_COLUMNS} FROM card_accounts ORDER BY created_at, rowid`)
      .all() as CardAccountRow[];
    return rows.map(mapCardAccountRow);
  }

  /**
   * Rename a card account (null or '' clears the nickname), close/reopen it,
   * or add (null clears) the five-digit ending of an account whose last four
   * digits it must end with. Issuer, owner, last4 and currency identify the
   * account and its imported rows, so they cannot change. Returns null when
   * it does not exist.
   */
  updateCardAccount(id: string, patch: CardAccountPatch): CardAccount | null {
    const current = this.getCardAccount(id);
    if (!current) return null;
    if (!patch || typeof patch !== 'object') throw new HoldrRefusal('card account patch must be an object');
    const nickname = patch.nickname === undefined
      ? current.nickname ?? null
      : optionalCardText(this.cardDetectors, 'nickname', patch.nickname, 80) ?? null;
    const status = patch.status === undefined ? current.status : patch.status;
    if (!CARD_ACCOUNT_STATUSES.has(status)) throw new HoldrRefusal('status must be active or closed');
    const last5 = patch.last5 === undefined || patch.last5 === null || patch.last5 === ''
      ? (patch.last5 === undefined ? current.last5 ?? null : null)
      : validLast5(patch.last5, current.last4);
    this.db
      .prepare(
        `UPDATE card_accounts SET nickname = ?, status = ?, last5 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(nickname, status, last5, id);
    return this.getCardAccount(id);
  }

  /**
   * Commit one redacted export for one card account, atomically. A row is
   * keyed by its external id hash or, without one, by a fingerprint whose
   * occurrence index counts identical id-less rows of this export. Rows whose
   * key is already stored for the card account (or repeated in the export)
   * are duplicates and are skipped, so re-importing an export from any
   * computer adds nothing while two identical purchases are both kept. Any
   * invalid row rejects the whole import before anything is written.
   *
   * Pending → posted only on identity: a posted row whose issuer reference
   * is stored for a pending row is that row, now posted, and is updated in
   * place. A fingerprint match is not identity (its occurrence number shifts
   * with the rows around it), so it posts the pending row only with
   * `promoteFingerprintMatches`, the owner's decision (or, row by row,
   * `promoteFingerprintMatchRows`); with
   * `insertFingerprintMatches`, the owner's word that it is another purchase,
   * it comes in as a new row under a free fingerprint occurrence; otherwise
   * it is a duplicate. A row the owner dismissed stays dismissed until the
   * owner says otherwise: a posted row with its reference posts it again only
   * with `promoteDismissedMatches` (it did post after all), and a pending one
   * never does. A pending row whose posted version arrives under another
   * reference stays pending: amount and dates alone cannot prove two rows are
   * one purchase, so `listPossiblePostedCardVersions` only suggests it, and
   * the owner dismisses the pending row or names its posted row
   * (`updateCardTransaction` with `postedAs`). Nothing is dismissed for being
   * absent from an import; `dismissPendingIds` dismisses, with the import,
   * the pending rows the owner says a complete, closed statement leaves out.
   * Posted rows never go back to pending.
   */
  importCardTransactions(input: CardImportInput): CardImportBatch {
    const imported = this.db.transaction(() => this.importV1Rows(input)).immediate();
    return this.getCardImportBatch(imported.batchId)!;
  }

  /**
   * A v1 import's classification, read-only (E1b design §5.7): Phase 4's
   * plan, the rows held or reviewed, the statement check and the
   * `previewDigest`, from one snapshot. The commit runs the same
   * classification inside its transaction, so on an unchanged ledger its
   * counts are the preview's.
   */
  previewCardImport(input: { cardAccountId: string; payload: CardImportPayload }): CardImportPreview {
    const account = this.getCardAccount(typeof input?.cardAccountId === 'string' ? input.cardAccountId : '');
    if (!account) throw new HoldrRefusal('card account does not exist');
    return this.db.transaction(() => this.classifyV1Import(account, input.payload))();
  }

  /**
   * A v1 import decided inside its transaction (§4.10.4, finding 11): the
   * classification again, then the owner's decisions checked against it
   * (an echoed `previewDigest` that no longer matches, a statement mismatch
   * not accepted, or a question whose rows differ from the complete lists
   * the route showed is `decision-required`), then the import itself, with
   * Phase 4's outcomes and E2d's holds and review sets. "Nothing new" (no
   * row inserted, posted or dismissed, no review work, the coverage already
   * recorded) is decided after the import knows its review work, and then
   * stores nothing at all.
   */
  commitCardImport(input: CardImportCommitInput): CardImportCommitResult {
    const account = this.getCardAccount(typeof input?.cardAccountId === 'string' ? input.cardAccountId : '');
    if (!account) throw new HoldrRefusal('card account does not exist');
    const { payload, decisions, shown } = input;
    return this.db.transaction((): CardImportCommitResult => {
      const preview = this.classifyV1Import(account, payload);
      const required = (kind: CardImportDecisionKind): CardImportCommitResult => ({ status: 'decision-required', kind, preview });
      if (input.previewDigest !== undefined && input.previewDigest !== preview.previewDigest) return required('preview-stale');
      if (preview.reconciliation.status === 'mismatch' && decisions.acceptMismatch !== true) return required('statement-mismatch');
      const { plan } = preview;
      const possible = indexesOf(plan, 'possible-duplicate');
      if (possible.length > 0 && (decisions.possibleDuplicates === undefined || !sameIndexes(possible, shown.possibleDuplicateRows))) {
        return required('possible-duplicates');
      }
      const matched = indexesOf(plan, 'pending-match');
      if (matched.length > 0 && (decisions.pendingMatches === undefined || !sameIndexes(matched, shown.pendingMatchRows))) {
        return required('pending-matches');
      }
      // A posted row like it is stored and no other row of the file is it: most likely that purchase again.
      if (matched.length > 0 && decisions.pendingMatches === 'import' && plan.matches.some((match) => match.twins.length > 0)) {
        return required('pending-match-twins');
      }
      const dismissedMatches = indexesOf(plan, 'dismissed-match');
      if (dismissedMatches.length > 0 && (decisions.dismissedMatches === undefined
        || !sameIndexes(dismissedMatches, shown.dismissedMatchRows))) {
        return required('dismissed-matches');
      }
      const dismissing = decisions.stalePending === 'dismiss' ? plan.stale.map((row) => row.id) : [];
      if (decisions.stalePending === 'dismiss' && !sameIds(dismissing, shown.stalePendingIds)) return required('stale-pending');

      const skip = new Set(decisions.possibleDuplicates === 'skip' ? possible : []);
      // Each kept payload row's index among the rows the import receives.
      const rowIndex = new Map<number, number>();
      const kept: CardImportPayloadRow[] = [];
      payload.rows.forEach((row, index) => {
        if (skip.has(index)) return;
        rowIndex.set(index, kept.length);
        kept.push(row);
      });
      // Leaving rows out must not move any other row's dedupe key.
      if (assignCardDedupeKeys(kept).some((key, index) => ('externalIdHash' in key ? key.externalIdHash : key.fingerprint)
        !== keyOf(kept[index]))) {
        throw new Error('possible-duplicate selection changed a dedupe key');
      }
      // split: the matches without a posted twin post, those with one stay as they are.
      const splitPosts = decisions.pendingMatches === 'split' ? plan.matches.filter((match) => match.twins.length === 0) : [];
      const covered = this.cardCoverageCovers(account.id, payload.coverage);
      const importing: CardImportInput = {
        cardAccountId: account.id, source: payload.source, parserVersion: payload.parserVersion,
        rejectedCount: payload.rejectedCount + skip.size, coverage: payload.coverage,
        promoteFingerprintMatches: decisions.pendingMatches === 'post', promoteDismissedMatches: decisions.dismissedMatches === 'post',
        insertFingerprintMatches: decisions.pendingMatches === 'import',
        promoteFingerprintMatchRows: splitPosts.map((match) => rowIndex.get(match.index)!), dismissPendingIds: dismissing,
        actorRef: input.actorRef,
        rows: kept.map((row) => ({
          externalIdHash: row.externalIdHash, transactionDate: row.transactionDate, postedDate: row.postedDate, status: row.status,
          amountMinor: row.amountMinor, currency: payload.currency, kind: row.kind, description: row.description, merchant: row.merchant,
          issuerCategory: row.issuerCategory,
        })),
        fileRowIndexes: payload.rows.flatMap((_row, index) => (skip.has(index) ? [] : [index])),
      };
      // A possible duplicate the owner chose to import is a new purchase on the owner's word: never held as well.
      const holdExempt = new Set(decisions.possibleDuplicates === 'import' ? possible : []);
      let outcome: CardImportOutcome | undefined;
      let nothingNew = false;
      try {
        this.db.transaction(() => {
          const imported = this.importV1Rows(importing, { holdExempt });
          outcome = imported;
          if (imported.newCount === 0 && imported.promotedCount === 0 && imported.dismissedCount === 0 && imported.reviewCount === 0
            && covered) {
            throw NOTHING_NEW;
          }
        })();
      } catch (error) {
        if (error !== NOTHING_NEW) throw error;
        nothingNew = true;
      }
      const done = outcome!;
      // What the import did once the owner's decisions and its holds applied (E2d review r1, finding 9): a promotion
      // withheld for review, a second key of one row or an insertion held is neither posted nor inserted.
      const counts: CardImportCommitCounts = {
        skippedPossibleDuplicates: skip.size, pendingPostedCount: done.promotedCount, pendingMatchesInsertedCount: done.insertedMatchCount,
        stalePendingDismissedCount: dismissing.length,
      };
      const applied: CardImportApplied = { heldRows: done.heldRows, heldOpenRows: done.heldOpenRows, reviewRows: done.reviewRows };
      if (nothingNew) return { status: 'nothing-new', preview, counts, applied };
      return { status: 'imported', preview, counts, applied, batch: this.getCardImportBatch(done.batchId)!, reviewCount: done.reviewCount,
        heldCount: done.heldCount };
    }).immediate();
  }

  /** Phase 4's plan and E2d's review work for a v1 payload, in the caller's transaction (reads only). */
  private classifyV1Import(account: CardAccount, payload: CardImportPayload): CardImportPreview {
    if (payload.issuer !== account.issuer || payload.currency !== account.currency) {
      throw new HoldrRefusal('the import is for another issuer or currency than this card account');
    }
    const now = this.now().toISOString();
    const writer = new CardLedgerWriter(this.db, now);
    const legacyScope = writer.legacyScopeOf(account.id);
    const stored = this.listCardTransactions({ cardAccountId: account.id });
    const byId = new Map(stored.map((row) => [row.id, row]));
    // Keys resolve as the import resolves them: through their legacy identities (a link, re-point or merge is followed).
    const legacy = new Map<string, LegacyHit | null>();
    const legacyHit = (key: string) => {
      if (!legacy.has(key)) legacy.set(key, writer.findLegacy(account.id, legacyScope, key) ?? null);
      return legacy.get(key) ?? undefined;
    };
    const plan = planImport(payload, stored, (key, row) => {
      const hit = legacyHit(key);
      const named = hit ? byId.get(hit.transactionId) : undefined;
      if (!hit || !named) return undefined;
      const active = hit.identityStatus === 'active';
      // Only a row that would promote asks (one content digest each), so a replay of posted rows computes none.
      return { row: named, active, get known() { return active && writer.knowsContent(hit.identityId, payloadRowValues(row)); } };
    });
    // The pass over the file (cardImport/review.ts), in file order, from Phase 4's outcome per row; rows that wait for the
    // owner's answer are only kept from being candidates (the commit runs the pass again with the answers).
    const firsts = new Set<string>();
    const rows: FileReviewInput[] = payload.rows.map((row, index) => {
      const key = keyOf(row);
      const repeated = firsts.has(key);
      firsts.add(key);
      const outcome = plan.rows[index];
      return {
        index, key, byReference: row.externalIdHash !== null, values: payloadRowValues(row), hit: repeated ? null : legacyHit(key) ?? null,
        repeated, exempt: false,
        outcome: outcome === 'new' ? 'insert' : outcome === 'promote' ? 'promote' : outcome === 'duplicate' ? 'duplicate' : 'question',
      };
    });
    const work = fileReviewWork(this.db, now, {
      account: { id: account.id, issuer: account.issuer, currency: account.currency }, legacyScopeId: legacyScope, rows,
    });
    const ledgerRevision = this.db.prepare('SELECT ledger_revision FROM card_accounts WHERE id = ?').pluck().get(account.id) as number;
    return {
      plan, heldRows: work.held.map((entry) => entry.row.index), heldOpenRows: work.heldOpen, reviewRows: work.review.map((entry) => entry.row.index),
      promotedRows: work.promoted.map((row) => row.index), reconciliation: reconcileCardImport(payload.totals.posted, payload.statement),
      previewDigest: cardImportPreviewDigest({ accountId: account.id, payloadJson: serializeCardImportPayload(payload), ledgerRevision,
        covered: this.cardCoverageCovers(account.id, payload.coverage), plan, work }),
    };
  }

  /**
   * The v1 import itself, inside the caller's transaction (importCardTransactions's
   * own, or commitCardImport's; both behind the value-free boundary, so this
   * private helper is not in CARD_REPO_OPERATIONS): Phase 4's outcomes for every row, except the
   * rows that meet what the browser extension wrote (E2d, design §4.10.4):
   * a row near a synced row is held for review instead of inserted, and a
   * duplicate of a mixed-source row with content the row does not know opens
   * a review item, both in the batch's file sets (services/cardImport/review.ts).
   */
  private importV1Rows(input: CardImportInput, options: { holdExempt?: ReadonlySet<number> } = {}): CardImportOutcome {
    const account = this.getCardAccount(typeof input?.cardAccountId === 'string' ? input.cardAccountId : '');
    if (!account) throw new HoldrRefusal('card account does not exist');
    const batch = validateCardImport(input, account, this.cardDetectors);
    const actor: LedgerActor = input.actorRef === undefined ? { kind: 'system' } : sessionActor(input.actorRef);
    const keys = assignCardDedupeKeys(batch.rows);
    const insertBatch = this.db.prepare(
      `INSERT INTO card_import_batches
         (id, card_account_id, source, parser_version, row_count, new_count, duplicate_count, rejected_count,
          coverage_start, coverage_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertWindow = this.db.prepare(
      `INSERT INTO card_coverage_windows (id, card_account_id, card_scope_id, source_kind, source, import_batch_id,
         observation_set_id, entry_ordinal, status, requested_start, requested_end, requested_basis, observed_start, observed_end,
         observed_basis, claimed_completeness, verified_completeness, termination, page_count, evidence, ledger_state, observed_at,
         recorded_at, updated_at)
       VALUES (?, ?, ?, 'file', ?, ?, NULL, NULL, 'any', ?, ?, 'posted-or-transaction', NULL, NULL, NULL, 'unknown', 'unknown',
         NULL, NULL, 'file-declared', 'committed', NULL, ?, ?)`,
    );
    {
      const now = this.now().toISOString();
      const writer = new CardLedgerWriter(this.db, now);
      const ledgerRevision = this.db.prepare('SELECT ledger_revision FROM card_accounts WHERE id = ?').pluck().get(account.id) as number;
      // v14's dedupe key, now looked up as the identity tuple (account,
      // legacy scope, legacy-file:v1, key): the same bijection the migration
      // backfilled, so every v14 outcome stands (design §3.3).
      const legacyScope = writer.legacyScopeOf(account.id);
      const seen = new Set<string>();
      // Rows the owner called different purchases from the pending rows their
      // fingerprints name: stored under the next occurrence that no stored
      // identity and no row of this import uses.
      const payloadKeys = new Set(keys.map(dedupeKeyValue));
      const rekeyed = new Set<number>();
      // Rows the owner posted one by one (promoteFingerprintMatchRows) that were fingerprint matches.
      const postedOneByOne = new Set<number>();
      const nextFreeFingerprint = (row: CardImportRow): string => {
        for (let occurrence = 0; occurrence <= MAX_CARD_IMPORT_ROWS; occurrence += 1) {
          const fingerprint = cardTransactionFingerprint(row, occurrence);
          if (payloadKeys.has(fingerprint) || writer.legacyKeyTaken(account.id, legacyScope, fingerprint)) continue;
          payloadKeys.add(fingerprint);
          return fingerprint;
        }
        throw new HoldrRefusal('no free fingerprint occurrence is left for a row');
      };
      // Each row's position in the v1 file: rows left out (possible duplicates skipped) never renumber the others
      // (E2d review r1, finding 7).
      if (input.fileRowIndexes && input.fileRowIndexes.length !== batch.rows.length) {
        throw new Error('card import: one file position per row is needed');
      }
      const positions = batch.rows.map((_row, index) => input.fileRowIndexes?.[index] ?? index);
      const byPosition = new Map(positions.map((position, index) => [position, index]));
      // Phase 4's outcome for every row once the owner's decisions apply; the pass (cardImport/review.ts) takes it from there.
      const rows: FileReviewInput[] = keys.map((key, index) => {
        const value = dedupeKeyValue(key);
        const row = batch.rows[index];
        const base: FileReviewInput = { index: positions[index], key: value, byReference: 'externalIdHash' in key, values: fileRowValues(row),
          hit: null, repeated: false, exempt: options.holdExempt?.has(positions[index]) ?? false, outcome: 'duplicate' };
        if (seen.has(value)) return { ...base, repeated: true };
        seen.add(value);
        const hit = writer.findLegacy(account.id, legacyScope, value) ?? null;
        if (!hit) return { ...base, outcome: 'insert' };
        if (row.status !== 'posted' || hit.identityStatus !== 'active'
          || !isPromotablePending({ id: hit.transactionId, status: hit.status, dismissed_at: hit.dismissedAt })) return { ...base, hit };
        const byFingerprint = !('externalIdHash' in key);
        if (byFingerprint && batch.promoteFingerprintMatchRows.has(index)) postedOneByOne.add(index);
        // Content already known for the identity is a replay, never a change
        // (§4.3): a duplicate, whatever the owner decided for new matches.
        if (writer.knowsContent(hit.identityId, fileRowValues(row))) return { ...base, hit };
        if (!byFingerprint) {
          // A reference posts a pending row by itself, a dismissed one only on the owner's word.
          const dismissed = isDismissedPending({ id: hit.transactionId, status: hit.status, dismissed_at: hit.dismissedAt });
          return { ...base, hit, outcome: !dismissed || batch.promoteDismissedMatches ? 'promote' : 'duplicate' };
        }
        // A fingerprint posts either only on the owner's word, for all matches or row by row.
        if (batch.promoteFingerprintMatches || batch.promoteFingerprintMatchRows.has(index)) return { ...base, hit, outcome: 'promote' };
        if (batch.insertFingerprintMatches) {
          // On the owner's word that it is another purchase, it comes in as a new row.
          rekeyed.add(positions[index]);
          return { ...base, hit, key: nextFreeFingerprint(row), byReference: false, outcome: 'insert' };
        }
        return { ...base, hit };
      });
      if (postedOneByOne.size !== batch.promoteFingerprintMatchRows.size) {
        throw new HoldrRefusal('a row to post as its pending row is not a fingerprint match of one; preview the import again');
      }
      // What the owner must decide first (E2d, §4.10.4, §4.11): rows held, promotions withheld, duplicates asked about.
      const work = fileReviewWork(this.db, now, {
        account: { id: account.id, issuer: account.issuer, currency: account.currency }, legacyScopeId: legacyScope, rows,
      });
      const keyAt = new Map(rows.map((row) => [row.index, row.key]));
      const batchId = newCardId('card-import');
      insertBatch.run(
        batchId,
        account.id,
        batch.source,
        batch.parserVersion,
        batch.rows.length + batch.rejectedCount,
        work.inserted.length,
        batch.rows.length - work.inserted.length - work.held.length,
        batch.rejectedCount + work.held.length,
        batch.coverage?.start ?? null,
        batch.coverage?.end ?? null,
      );
      // Same key, now posted: the pending row itself becomes posted, keeping
      // its id, custom category and notes; the posted version's fields win.
      // One write per row, whatever number of the file's keys name it (finding 6).
      writer.promoteFileRows({
        cardAccountId: account.id, batchId, actor,
        rows: work.promoted.map((row) => ({ hit: row.hit!, row: fileRowValues(batch.rows[byPosition.get(row.index)!]) })),
      });
      writer.insertFileRows({
        cardAccountId: account.id, legacyScopeId: legacyScope, batchId, source: batch.source, currency: account.currency, actor,
        rows: work.inserted.map((position) => ({ key: keyAt.get(position)!, row: fileRowValues(batch.rows[byPosition.get(position)!]) })),
      });
      // Another key of a row this import posted, with the same values: unchanged, and now known for that key.
      for (const alias of work.remembered) {
        if (writer.rememberContent(alias.identityId, rowContentDigest(alias.values), 'matched-current')) writer.markChanged(account.id);
      }
      // The owner's dismissals that come with this import (pending rows a
      // complete, closed statement leaves out). The rows stay, as dismissed,
      // so their identities still answer for them; all or nothing with the import.
      for (const transactionId of batch.dismissPendingIds) {
        writer.dismissWithImport({ transactionId, cardAccountId: account.id, batchId, actor });
      }
      // The import's declared coverage, on the legacy scope, as the v15 backfill records v14's.
      if (batch.coverage) {
        insertWindow.run(newCardSyncRowId('card-cover-'), account.id, legacyScope, batch.source, batchId, batch.coverage.start,
          batch.coverage.end, now, now);
      }
      const reviewCount = persistFileReviewSets(this.db, now, this.syncStatements ??= new CardSyncStatements(this.db), {
        account: { id: account.id, issuer: account.issuer, currency: account.currency }, batchId, source: batch.source,
        parserVersion: batch.parserVersion, guardRevision: this.guardRevision, ledgerRevision,
        reviewRetentionDays: this.db.prepare("SELECT review_retention_days FROM card_sync_policy WHERE id = 'card-sync-policy'").pluck()
          .get() as number,
        entries: [...work.held, ...work.review],
      });
      writer.finish();
      return {
        batchId, reviewCount, heldCount: work.held.length, newCount: work.inserted.length, promotedCount: work.promoted.length,
        dismissedCount: batch.dismissPendingIds.length, insertedMatchCount: work.inserted.filter((position) => rekeyed.has(position)).length,
        heldRows: work.held.map((entry) => entry.row.index), heldOpenRows: work.heldOpen, reviewRows: work.review.map((entry) => entry.row.index),
      };
    }
  }

  /** Card sync settings (E1b design §5.1): pause, retention, quotas and the four issuers, with the version an edit names. */
  getCardSyncSettings(): CardSyncSettings {
    return cardSyncSettings.readCardSyncSettings(this.db);
  }

  /** Pauses all card syncing (narrowing: no version, always wins; an authorization change, §5.0). */
  pauseCardSync(input: { actorRef: string } & CardSyncGenerationStep): CardSyncAuthChange<CardSyncSettings> {
    return this.syncWrite((ctx) => cardSyncSettings.pauseCardSync(ctx, input));
  }

  /** Resumes card syncing at the settings version the owner saw (widening; E2's gate must be open). */
  resumeCardSync(input: { expectedVersion: number; actorRef: string } & CardSyncGenerationStep): CardSyncAuthChange<CardSyncSettings> {
    return this.syncWrite((ctx) => cardSyncSettings.resumeCardSync(ctx, input));
  }

  /** Turns an issuer on: risk acknowledged, a supported contract version, MAIN-world consent for Amex and Citi (widening). */
  enableCardSyncIssuer(input: Parameters<typeof cardSyncSettings.enableCardSyncIssuer>[1]): CardSyncAuthChange<CardSyncSettings> {
    return this.syncWrite((ctx) => cardSyncSettings.enableCardSyncIssuer(ctx, input));
  }

  /** Turns an issuer off, withdrawing its consent (narrowing). */
  disableCardSyncIssuer(input: Parameters<typeof cardSyncSettings.disableCardSyncIssuer>[1]): CardSyncAuthChange<CardSyncSettings> {
    return this.syncWrite((ctx) => cardSyncSettings.disableCardSyncIssuer(ctx, input));
  }

  /** Review and receipt retention and the quotas, at the settings version the owner saw (not authorization). */
  updateCardSyncRetention(input: Parameters<typeof cardSyncSettings.updateCardSyncRetention>[1]): CardSyncSettings {
    return this.syncWrite((ctx) => cardSyncSettings.updateCardSyncRetention(ctx, input));
  }

  /** The database's authorization generation, for E2's gate only; never sent to a client. */
  getCardSyncAuthorizationGeneration(): string {
    return cardSyncSettings.readCardSyncAuthorizationGeneration(this.db);
  }

  /** Scopes and bindings (E1b design §5.2), each with its scopes, devices and auto-sync switch; oldest first. */
  listCardSourceBindings(filter: { cardAccountId?: string } = {}): CardSourceBindingView[] {
    return this.syncRead((ctx) => cardSyncBindings.listCardSourceBindings(ctx.db, filter));
  }

  /** One binding's view, or null. */
  getCardSourceBinding(bindingId: string): CardSourceBindingView | null {
    return this.syncRead((ctx) => cardSyncBindings.getCardSourceBinding(ctx.db, bindingId));
  }

  /** A new binding of a registered source on a card account, with its known scopes and the account's unknown one (widening). */
  createCardSourceBinding(input: Parameters<typeof cardSyncBindings.createCardSourceBinding>[1]): CardSyncAuthChange<CardSourceBindingView> {
    return this.syncWrite((ctx) => cardSyncBindings.createCardSourceBinding(ctx, input));
  }

  /** Confirms a binding again at the version the owner saw: scopes kept, added or retired, devices re-granted or left stale. */
  confirmCardSourceBinding(input: Parameters<typeof cardSyncBindings.confirmCardSourceBinding>[1]): CardSyncAuthChange<CardSourceBindingView> {
    return this.syncWrite((ctx) => cardSyncBindings.confirmCardSourceBinding(ctx, input));
  }

  /** Retires a binding for good: grants revoked, open sets blocked, their plans cancelled (narrowing). */
  retireCardSourceBinding(input: Parameters<typeof cardSyncBindings.retireCardSourceBinding>[1]): CardSyncAuthChange<CardSourceBindingView> {
    return this.syncWrite((ctx) => cardSyncBindings.retireCardSourceBinding(ctx, input));
  }

  /** The binding's auto-sync switch: off always applies to a live binding; on stays `gate-closed` until E4–E7 admit a namespace. */
  setCardSyncAutoSync(input: Parameters<typeof cardSyncBindings.setCardSyncAutoSync>[1]): CardSyncAuthChange<CardSourceBindingView> {
    return this.syncWrite((ctx) => cardSyncBindings.setCardSyncAutoSync(ctx, input));
  }

  /** A new invitation for a browser, cancelling the owner's open one (widening; E2 holds the code, the database its digest). */
  createCardSyncPairing(input: Parameters<typeof cardSyncDevices.createCardSyncPairing>[1]): CardSyncAuthChange<CardSyncPairingView> {
    return this.syncWrite((ctx) => cardSyncDevices.createCardSyncPairing(ctx, input));
  }

  /** Cancels an invitation, revoking a browser that redeemed it and waits (narrowing). */
  cancelCardSyncPairing(input: Parameters<typeof cardSyncDevices.cancelCardSyncPairing>[1]): CardSyncAuthChange<CardSyncPairingView> {
    return this.syncWrite((ctx) => cardSyncDevices.cancelCardSyncPairing(ctx, input));
  }

  /** One invitation's view, or null. */
  getCardSyncPairing(pairingId: string): CardSyncPairingView | null {
    return this.syncRead((ctx) => cardSyncDevices.getCardSyncPairing(ctx.db, pairingId));
  }

  /** Open and redeemed invitations, and those closed in the last 24 hours. */
  listCardSyncPairings(): CardSyncPairingView[] {
    return this.syncRead((ctx) => cardSyncDevices.listCardSyncPairings(ctx));
  }

  /** A browser presents a code: redeemed, or the failure recorded and `{ ok: false }` answered (never thrown). */
  redeemCardSyncPairing(input: Parameters<typeof cardSyncDevices.redeemCardSyncPairing>[1], effects?: {
    before(): void; after(result: CardSyncRedeemResult): void;
  }): CardSyncRedeemResult {
    return this.syncWrite((ctx) => {
      effects?.before();
      const result = cardSyncDevices.redeemCardSyncPairing(ctx, input);
      effects?.after(result);
      return result;
    });
  }

  cancelPendingCardSyncRedemption(input: Parameters<typeof cardSyncDevices.cancelPendingCardSyncRedemption>[1]) {
    return this.syncWrite((ctx) => cardSyncDevices.cancelPendingCardSyncRedemption(ctx, input));
  }

  /** Approves a redeemed invitation's browser: grants from the frozen scopes, and the replaced browser rotated out. */
  approveCardSyncPairing(input: Parameters<typeof cardSyncDevices.approveCardSyncPairing>[1]):
    CardSyncAuthChange<{ pairing: CardSyncPairingView; device: CardSyncDeviceView }> {
    return this.syncWrite((ctx) => cardSyncDevices.approveCardSyncPairing(ctx, input));
  }

  /** Rejects a redeemed invitation's browser (narrowing). */
  rejectCardSyncPairing(input: Parameters<typeof cardSyncDevices.rejectCardSyncPairing>[1]):
    CardSyncAuthChange<{ pairing: CardSyncPairingView; device: CardSyncDeviceView }> {
    return this.syncWrite((ctx) => cardSyncDevices.rejectCardSyncPairing(ctx, input));
  }

  /** Revokes a browser for the owner or a password reset, taking every authority it holds (narrowing). */
  revokeCardSyncDevice(input: Parameters<typeof cardSyncDevices.revokeCardSyncDevice>[1]): CardSyncAuthChange<CardSyncDeviceView> {
    return this.syncWrite((ctx) => cardSyncDevices.revokeCardSyncDevice(ctx, input));
  }

  /** Renews an active browser's grants that a re-confirmation left stale (widening). */
  regrantCardSyncDevice(input: Parameters<typeof cardSyncDevices.regrantCardSyncDevice>[1]): CardSyncAuthChange<CardSyncDeviceView> {
    return this.syncWrite((ctx) => cardSyncDevices.regrantCardSyncDevice(ctx, input));
  }

  /** E2's `HoldrDevice` resolver: a live device by its token digest, or null (read-only). */
  findCardSyncDeviceByTokenDigest(tokenDigest: string): CardSyncDeviceAuth | null {
    return this.syncRead((ctx) => cardSyncDevices.findCardSyncDeviceByTokenDigest(ctx, tokenDigest));
  }

  /** Records a live device's use, at most once a minute; whether it wrote. Not authorization. */
  touchCardSyncDevice(deviceId: string): boolean {
    return this.syncWrite((ctx) => cardSyncDevices.touchCardSyncDevice(ctx, deviceId));
  }

  /** One device's view (never a digest), or null. */
  getCardSyncDevice(deviceId: string): CardSyncDeviceView | null {
    return this.syncRead((ctx) => cardSyncDevices.getCardSyncDevice(ctx.db, deviceId));
  }

  /** Every device, or one user's (`ownerRef`), oldest first. */
  listCardSyncDevices(filter: { ownerRef?: string } = {}): CardSyncDeviceView[] {
    return this.syncRead((ctx) => cardSyncDevices.listCardSyncDevices(ctx.db, filter));
  }

  /** Opens a device's run (idempotent on its client run id; the current-source authorization re-read). */
  createCardSyncRun(input: Parameters<typeof cardSyncRuns.createCardSyncRun>[1]): ReturnType<typeof cardSyncRuns.createCardSyncRun> {
    return this.syncWrite((ctx) => cardSyncRuns.createCardSyncRun(ctx, input));
  }

  /** Records why E2 refused a run's upload; an accepted or closed run is left alone. Whether it wrote. */
  recordCardSyncRunRefusal(input: Parameters<typeof cardSyncRuns.recordCardSyncRunRefusal>[1]): boolean {
    return this.syncWrite((ctx) => cardSyncRuns.recordCardSyncRunRefusal(ctx, input));
  }

  /** The extension stopped a run: open → aborted, or an accepted run's reason recorded and its prepared plans cancelled. */
  abortCardSyncRun(input: Parameters<typeof cardSyncRuns.abortCardSyncRun>[1]): CardSyncRunView {
    return this.syncWrite((ctx) => cardSyncRuns.abortCardSyncRun(ctx, input));
  }

  /** One run, or null. */
  getCardSyncRun(runId: string): CardSyncRunView | null {
    return this.syncRead((ctx) => cardSyncRuns.getCardSyncRun(ctx.db, runId));
  }

  /** One indexed device/client-run lookup, including when an upload body is too large or malformed to reveal its run id. */
  getCardSyncRunByClientRunId(input: Parameters<typeof cardSyncRuns.getCardSyncRunByClientRunId>[1]): CardSyncRunView | null {
    return this.syncRead((ctx) => cardSyncRuns.getCardSyncRunByClientRunId(ctx.db, input));
  }

  /** A run's receipt: a device's own run, or any run for the owner and the service token. */
  getCardSyncRunReceipt(input: Parameters<typeof cardSyncRuns.getCardSyncRunReceipt>[1]): CardSyncRunView {
    return this.syncRead((ctx) => cardSyncRuns.getCardSyncRunReceipt(ctx.db, input));
  }

  /** Runs newest first, in pages of 1–50. */
  listCardSyncRuns(input: Parameters<typeof cardSyncRuns.listCardSyncRuns>[1]): { runs: CardSyncRunView[]; next: CardSyncRunCursor | null } {
    return this.syncRead((ctx) => cardSyncRuns.listCardSyncRuns(ctx.db, input));
  }

  /** Stores a device upload as an observation set with its first review items (§5.4); never writes a ledger row. */
  acceptCardSyncObservations(input: Parameters<typeof cardSyncAcceptance.acceptCardSyncObservations>[1]):
    cardSyncAcceptance.CardSyncAcceptanceReceipt {
    return this.syncWrite((ctx) => cardSyncAcceptance.acceptCardSyncObservations(ctx, input));
  }

  /** An accepted payload's canonical bytes while its receipt is kept; `receipt-expired` afterwards (§5.4). */
  getCardSyncPayloadReceipt(input: { setId: string }): ReturnType<typeof cardSyncAcceptance.getCardSyncPayloadReceipt> {
    return this.syncRead((ctx) => cardSyncAcceptance.getCardSyncPayloadReceipt(ctx, input));
  }

  /** The owner deletes a payload receipt early (§5.3.1); idempotent once gone. */
  deleteCardSyncReceipt(input: { setId: string; actorRef: string }): void {
    const actorRef = sessionActorRef(input?.actorRef);
    this.syncWrite((ctx) => cardSyncAcceptance.deleteCardSyncReceipt(ctx, { setId: input.setId, actorRef }));
  }

  /** Rebuilds an extension set's payload from storage (§5.4, internal): `ok` only when it revalidates to the stored digest. */
  rehydrateCardSyncPayload(setId: string): ReturnType<typeof cardSyncSets.rehydrateCardSyncPayload> {
    return this.syncRead((ctx) => cardSyncSets.rehydrateCardSyncPayload(ctx.db, setId));
  }

  /** Observation sets newest first: `open` (open and inside the deadline) or `closed` (§5.5). */
  listCardSyncObservationSets(input: Parameters<typeof cardSyncReview.listCardSyncObservationSets>[1]):
    ReturnType<typeof cardSyncReview.listCardSyncObservationSets> {
    return this.syncRead((ctx) => cardSyncReview.listCardSyncObservationSets(ctx, input));
  }

  /** One page of a set's items, pinned to the first page's snapshot (`page-stale` otherwise, §5.5). */
  getCardSyncObservationSetPage(input: Parameters<typeof cardSyncReview.getCardSyncObservationSetPage>[1]):
    cardSyncReview.CardSyncSetPage | null {
    return this.syncRead((ctx) => cardSyncReview.getCardSyncObservationSetPage(ctx, input));
  }

  /** Re-classifies an open set whose review mark is behind the ledger (§4.5); E2 calls it before rendering. */
  refreshCardReviewItems(input: { setId: string }): ReturnType<typeof cardSyncReview.refreshCardReviewItems> {
    return this.syncWrite((ctx) => cardSyncReview.refreshCardReviewItems(ctx, input));
  }

  /** A batch of 1–200 owner decisions on one set version, validated and stored whole (§4.10.2). */
  recordCardReviewDecisions(input: Parameters<typeof cardSyncReview.recordCardReviewDecisions>[1]): cardSyncReview.CardSyncSetPage {
    return this.syncWrite((ctx) => cardSyncReview.recordCardReviewDecisions(ctx, input, cardSyncPlans.requireReversible(ctx)));
  }

  /** Discards an open set: its content deleted, its tombstone kept (§5.5). */
  discardCardSyncObservationSet(input: Parameters<typeof cardSyncReview.discardCardSyncObservationSet>[1]):
    cardSyncReview.CardSyncSetSummary {
    return this.syncWrite((ctx) => cardSyncReview.discardCardSyncObservationSet(ctx, input));
  }

  /** A device's preview with a hand-off, or the owner's executable plan (§5.6). */
  prepareCardSyncPlan(input: Parameters<typeof cardSyncPlans.prepareCardSyncPlan>[1]):
    cardSyncPlans.CardSyncPlanView | cardSyncPlans.CardSyncOwnerReview {
    return this.syncWrite((ctx) => cardSyncPlans.prepareCardSyncPlan(ctx, input));
  }

  /** Recomputes, compares and applies a prepared plan whole; idempotent per plan for its principal (§4.10.3). */
  commitCardSyncPlan(input: Parameters<typeof cardSyncPlans.commitCardSyncPlan>[1]): cardSyncPlans.CardSyncCommitResult {
    return this.syncWrite((ctx) => cardSyncPlans.commitCardSyncPlan(ctx, input));
  }

  /** One page of a plan's effects for the principal that prepared it (§5.6). */
  getCardSyncPlanEffectsPage(input: Parameters<typeof cardSyncPlans.getCardSyncPlanEffectsPage>[1]):
    ReturnType<typeof cardSyncPlans.getCardSyncPlanEffectsPage> {
    return this.syncRead((ctx) => cardSyncPlans.getCardSyncPlanEffectsPage(ctx, input));
  }

  /** Removes a live card transaction on the owner's word (§5.7). */
  removeCardTransaction(input: Parameters<typeof cardSyncLedger.removeCardTransaction>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.removeCardTransaction(ctx, input));
  }

  /** Restores a removed card transaction to the status it was removed from (§5.7). */
  restoreCardTransaction(input: Parameters<typeof cardSyncLedger.restoreCardTransaction>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.restoreCardTransaction(ctx, input));
  }

  /** Moves a card transaction to another scope of its account (plan §7.2.1, §5.7). */
  attributeCardTransaction(input: Parameters<typeof cardSyncLedger.attributeCardTransaction>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.attributeCardTransaction(ctx, input));
  }

  /** Merges two live card transactions of one account (§5.7). */
  mergeCardTransactions(input: Parameters<typeof cardSyncLedger.mergeCardTransactions>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.mergeCardTransactions(ctx, input));
  }

  /** Undoes a merge in §4.9.3's order, at any age (§5.7.1). */
  unmergeCardTransaction(input: Parameters<typeof cardSyncLedger.unmergeCardTransaction>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.unmergeCardTransaction(ctx, input));
  }

  /** Detaches an active alias of a card transaction (§5.7.1). */
  detachCardSourceIdentity(input: Parameters<typeof cardSyncLedger.detachCardSourceIdentity>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.detachCardSourceIdentity(ctx, input));
  }

  /** Re-points an active alias to another live card transaction of the account (§5.7.1). */
  repointCardSourceIdentity(input: Parameters<typeof cardSyncLedger.repointCardSourceIdentity>[1]):
    ReturnType<typeof cardSyncLedger.repointCardSourceIdentity> {
    return this.syncWrite((ctx) => cardSyncLedger.repointCardSourceIdentity(ctx, input));
  }

  /** Reverts a card transaction's latest reversible change (§5.7.1). */
  revertCardTransactionChange(input: Parameters<typeof cardSyncLedger.revertCardTransactionChange>[1]): cardSyncLedger.CardLedgerRowView {
    return this.syncWrite((ctx) => cardSyncLedger.revertCardTransactionChange(ctx, input));
  }

  /** A card transaction's sources, merged rows, revertible change and history, paged (§5.7.1). */
  getCardTransactionSources(input: Parameters<typeof cardSyncLedger.getCardTransactionSources>[1]):
    cardSyncLedger.CardTransactionSources | null {
    return this.syncRead((ctx) => cardSyncLedger.getCardTransactionSources(ctx, input));
  }

  /** Pending card transactions no source has shown again for `days` (default 14). */
  listStalePendingCardTransactions(input: { days?: number } = {}): cardSyncLedger.CardLedgerRowView[] {
    return this.syncRead((ctx) => cardSyncLedger.listStalePendingCardTransactions(ctx, input));
  }

  /** E2's recovery CLI only: closes every card-sync authority a restored backup could carry (§5.8). */
  invalidateAllCardSyncAuthorization(input: { nextGeneration: string }): cardSyncRecovery.CardSyncRecoveryReport {
    return this.syncWrite((ctx) => cardSyncRecovery.invalidateAllCardSyncAuthorization(ctx, input));
  }

  /**
   * One retention call: the seven phases in chunks within the work budget (§5.9), written only when the WAL has no
   * frames left to copy back (O100). The call first copies back whatever the WAL holds (a PASSIVE checkpoint). If that
   * leaves frames a reader still needs, or another connection commits before this call holds the write lock (PRAGMA
   * data_version), the call writes nothing and reports `deferred`. So retention never writes on top of frames not yet
   * copied back, and its frames waiting to be copied back never exceed one call's. That bounds the copy-back work, not
   * the WAL file: a reader can keep the WAL from restarting, and frames already copied back then stay in it. The fence
   * is the database's own state, not this process's, so it holds across passes, restarts and processes (C30). The
   * call's commit never checkpoints: the auto-checkpoint is off for it and restored on every exit, and
   * checkpointAfterCardSyncRetention copies its frames back in a turn of its own, so neither step runs long.
   */
  runCardSyncRetention(input: { budgetMs?: number } = {}): cardSyncRetention.CardSyncRetentionReport {
    cardSyncRetention.cardSyncRetentionBudget(input);
    const version = this.dataVersion();
    if (!this.passiveCheckpoint().complete) return this.syncRead((ctx) => cardSyncRetention.deferredCardSyncRetention(ctx));
    const autoCheckpoint = this.db.pragma('wal_autocheckpoint', { simple: true }) as number;
    this.db.pragma('wal_autocheckpoint = 0');
    try {
      return this.syncWrite((ctx) => (this.dataVersion() === version
        ? cardSyncRetention.runCardSyncRetention(ctx, input)
        : cardSyncRetention.deferredCardSyncRetention(ctx)));
    } finally {
      this.db.pragma(`wal_autocheckpoint = ${autoCheckpoint}`);
    }
  }

  /**
   * Around retention calls, in a turn of its own (before a pass's first call and after each call): copies the WAL's
   * frames back into the database without waiting for readers (PASSIVE). `complete` is false while a reader still
   * needs older frames; the scheduler then ends its pass, and no retention call writes until a checkpoint completes
   * (O100).
   */
  checkpointAfterCardSyncRetention(): { complete: boolean; frames: number; checkpointed: number } {
    return this.passiveCheckpoint();
  }

  /** A PASSIVE checkpoint: copies back the WAL frames no reader still needs, waiting for none. */
  private passiveCheckpoint(): { complete: boolean; frames: number; checkpointed: number } {
    const [result] = this.db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
    return { complete: result.busy === 0 && result.checkpointed === result.log, frames: result.log, checkpointed: result.checkpointed };
  }

  /** Changes whenever another connection commits to this database (PRAGMA data_version). */
  private dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number;
  }

  /** Coverage windows by account, scope and ledger state (§5.10). */
  listCardCoverageWindows(filter: Parameters<typeof cardSyncCoverage.listCardCoverageWindows>[1] = {}):
    cardSyncCoverage.CardCoverageWindowView[] {
    return this.syncRead((ctx) => cardSyncCoverage.listCardCoverageWindows(ctx, filter));
  }

  /** An account's committed coverage as merged spans of equal windows (§5.10). */
  mergedCardCoverage(filter: { cardAccountId: string }): cardSyncCoverage.CardCoverageSpan[] {
    return this.syncRead((ctx) => cardSyncCoverage.mergedCardCoverage(ctx, filter));
  }

  /** The owner API's set list (E2a, §5.5): `SetSummary` pages newest first. */
  listCardSyncOwnerSets(input: Parameters<typeof cardSyncOwner.listOwnerSets>[1]): ReturnType<typeof cardSyncOwner.listOwnerSets> {
    return this.syncRead((ctx) => cardSyncOwner.listOwnerSets(ctx, input));
  }

  /**
   * One page of a set as the owner API's `SetDetail` (§5.5, R7). The first
   * page refreshes a set whose review mark is behind the ledger, in the same
   * transaction as the read (§10 item 4); later pages only read. Every answer
   * comes from one snapshot (review r2, finding 3): a first page found fresh
   * is read in the transaction that found it fresh, and one found stale is
   * refreshed and read in one write transaction, whose refresh checks again.
   */
  getCardSyncOwnerSet(input: { setId: string; after: cardSyncReview.CardSyncSetPageCursor | null; actorRef: string }):
    ReturnType<typeof cardSyncOwner.ownerSetPage> {
    const first = input?.after === null;
    const page = this.syncRead((ctx) => (first && cardSyncOwner.setNeedsRefresh(ctx, input.setId)
      ? STALE_FIRST_PAGE : cardSyncOwner.ownerSetPage(ctx, { ...input, refresh: false })));
    if (page !== STALE_FIRST_PAGE) return page;
    return this.syncWrite((ctx) => cardSyncOwner.ownerSetPage(ctx, { ...input, refresh: true }));
  }

  /** A set's current version (for a `version-conflict` answer), or null. */
  getCardSyncOwnerSetVersion(setId: string): number | null {
    return this.syncRead((ctx) => cardSyncOwner.ownerSetVersion(ctx, setId));
  }

  /** A decision batch (§4.10.2) answered with the set's first page, in one transaction. */
  recordCardSyncOwnerDecisions(input: Parameters<typeof cardSyncOwner.recordOwnerDecisions>[1]):
    ReturnType<typeof cardSyncOwner.recordOwnerDecisions> {
    return this.syncWrite((ctx) => cardSyncOwner.recordOwnerDecisions(ctx, input));
  }

  /** Owner prepare (§5.6) answered with the plan's first page of effects and their values, in one transaction. */
  prepareCardSyncOwnerPlan(input: Parameters<typeof cardSyncOwner.prepareOwnerPlan>[1]): ReturnType<typeof cardSyncOwner.prepareOwnerPlan> {
    return this.syncWrite((ctx) => cardSyncOwner.prepareOwnerPlan(ctx, input));
  }

  /** A later page of the owner's plan's effects with their values (§5.6); null when the owner has no such plan. */
  getCardSyncOwnerPlanEffects(input: Parameters<typeof cardSyncOwner.ownerPlanEffects>[1]): ReturnType<typeof cardSyncOwner.ownerPlanEffects> {
    return this.syncRead((ctx) => cardSyncOwner.ownerPlanEffects(ctx, input));
  }

  /** Owner commit (§4.10.3) answered as `CommitResult`. */
  commitCardSyncOwnerPlan(input: Parameters<typeof cardSyncOwner.commitOwnerPlan>[1]): cardSyncOwnerViews.OwnerCommitResult {
    return this.syncWrite((ctx) => cardSyncOwner.commitOwnerPlan(ctx, input));
  }

  /** Discard (§5.5) answered as `SetSummary`. */
  discardCardSyncOwnerSet(input: Parameters<typeof cardSyncOwner.discardOwnerSet>[1]): cardSyncOwnerViews.OwnerSetSummary {
    return this.syncWrite((ctx) => cardSyncOwner.discardOwnerSet(ctx, input));
  }

  /** Runs newest first as `RunSummary` pages, optionally of one binding. */
  listCardSyncOwnerRuns(input: Parameters<typeof cardSyncOwner.listOwnerRuns>[1]): ReturnType<typeof cardSyncOwner.listOwnerRuns> {
    return this.syncRead((ctx) => cardSyncOwner.listOwnerRuns(ctx, input));
  }

  /** One run as `RunDetail`, or null. */
  getCardSyncOwnerRun(runId: string): cardSyncOwnerViews.OwnerRunDetail | null {
    return this.syncRead((ctx) => cardSyncOwner.ownerRun(ctx, runId));
  }

  /** The exact object a run sent, while its receipt is kept (§5.4); null for no such run. */
  getCardSyncOwnerRunPayload(runId: string): ReturnType<typeof cardSyncOwner.ownerRunPayload> {
    return this.syncRead((ctx) => cardSyncOwner.ownerRunPayload(ctx, runId));
  }

  /** A card transaction's sources as `TransactionSources` (§5.7.1); null for no such transaction. */
  getCardSyncOwnerSources(input: Parameters<typeof cardSyncOwner.ownerSources>[1]): ReturnType<typeof cardSyncOwner.ownerSources> {
    return this.syncRead((ctx) => cardSyncOwner.ownerSources(ctx, input));
  }

  /** Maintenance detach (§5.7.1) answered with the row's sources, in one transaction. */
  detachCardSyncOwnerIdentity(input: Parameters<typeof cardSyncOwner.detachOwnerIdentity>[1]):
    ReturnType<typeof cardSyncOwner.detachOwnerIdentity> {
    return this.syncWrite((ctx) => cardSyncOwner.detachOwnerIdentity(ctx, input));
  }

  /** Maintenance re-point (§5.7.1) answered with the sources of the row the alias left, in one transaction. */
  repointCardSyncOwnerIdentity(input: Parameters<typeof cardSyncOwner.repointOwnerIdentity>[1]):
    ReturnType<typeof cardSyncOwner.repointOwnerIdentity> {
    return this.syncWrite((ctx) => cardSyncOwner.repointOwnerIdentity(ctx, input));
  }

  /** Maintenance revert (§5.7.1) answered with the row's sources, in one transaction. */
  revertCardSyncOwnerChange(input: Parameters<typeof cardSyncOwner.revertOwnerChange>[1]): ReturnType<typeof cardSyncOwner.revertOwnerChange> {
    return this.syncWrite((ctx) => cardSyncOwner.revertOwnerChange(ctx, input));
  }

  /** Maintenance unmerge (§5.7.1) answered with the separated row's sources, in one transaction. */
  unmergeCardSyncOwnerTransaction(input: Parameters<typeof cardSyncOwner.unmergeOwnerTransaction>[1]):
    ReturnType<typeof cardSyncOwner.unmergeOwnerTransaction> {
    return this.syncWrite((ctx) => cardSyncOwner.unmergeOwnerTransaction(ctx, input));
  }

  // ---- E2b: the owner API's authorization routes (owner API §3.1–§3.4; E1b §10 items 2, 6, 10, 12, 15, 16) ----------
  // Each change runs the E1b function and answers in the owner's shape in the same IMMEDIATE transaction; the state is one
  // read transaction. E2's generation protocol (control/authorizationChange.ts) supplies the generations.

  /** `GET /owner/state`'s database part (§3.1), in one read transaction. */
  getCardSyncOwnerState(): cardSyncOwnerAuthorization.OwnerStateParts {
    return this.syncRead((ctx) => cardSyncOwnerAuthorization.ownerStateParts(ctx));
  }

  getCardSyncOwnerAuthorityPage(input: Parameters<typeof cardSyncOwnerAuthorization.ownerAuthorityPage>[1]) {
    return this.syncRead((ctx) => cardSyncOwnerAuthorization.ownerAuthorityPage(ctx, input));
  }

  /** A binding as the owner API's `Binding`, or null (a version-conflict answer's current version). */
  getCardSyncOwnerBinding(bindingId: string): cardSyncOwnerAuthorization.OwnerBinding | null {
    return this.syncRead((ctx) => cardSyncOwnerAuthorization.ownerBindingById(ctx, bindingId));
  }

  /** A browser as the owner API's `Device`, or null. */
  getCardSyncOwnerDevice(deviceId: string): cardSyncOwnerAuthorization.OwnerDevice | null {
    return this.syncRead((ctx) => cardSyncOwnerAuthorization.ownerDeviceById(ctx, deviceId));
  }

  /** Pause, answered as `Settings` (narrowing). */
  pauseCardSyncOwner(input: Parameters<typeof cardSyncOwnerAuthorization.ownerPause>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerSettings> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerPause(ctx, input));
  }

  /** Resume, answered as `Settings` (widening). */
  resumeCardSyncOwner(input: Parameters<typeof cardSyncOwnerAuthorization.ownerResume>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerSettings> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerResume(ctx, input));
  }

  /** Issuer enable (with its contract approval and MAIN consent), answered as `Settings` (widening). */
  enableCardSyncOwnerIssuer(input: Parameters<typeof cardSyncOwnerAuthorization.ownerEnableIssuer>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerSettings> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerEnableIssuer(ctx, input));
  }

  /** Issuer disable, answered as `Settings` (narrowing). */
  disableCardSyncOwnerIssuer(input: Parameters<typeof cardSyncOwnerAuthorization.ownerDisableIssuer>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerSettings> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerDisableIssuer(ctx, input));
  }

  /** A new binding, answered as `Binding` (widening). */
  createCardSyncOwnerBinding(input: Parameters<typeof cardSyncOwnerAuthorization.ownerCreateBinding>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerBinding> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerCreateBinding(ctx, input));
  }

  /** (Re-)confirmation with its re-grants, answered as `Binding` (widening). */
  confirmCardSyncOwnerBinding(input: Parameters<typeof cardSyncOwnerAuthorization.ownerConfirmBinding>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerBinding> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerConfirmBinding(ctx, input));
  }

  /** Retirement, answered as `Binding` (narrowing). */
  retireCardSyncOwnerBinding(input: Parameters<typeof cardSyncOwnerAuthorization.ownerRetireBinding>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerBinding> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerRetireBinding(ctx, input));
  }

  /** The auto-sync switch, answered as `Binding` (on widening, off narrowing; every off moves the revision, R1). */
  setCardSyncOwnerAutoSync(input: Parameters<typeof cardSyncOwnerAuthorization.ownerSetAutoSync>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerBinding> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerSetAutoSync(ctx, input));
  }

  /** A new invitation (E2 holds the code; the database its digest), answered as `Pairing` (widening). */
  createCardSyncOwnerPairing(input: Parameters<typeof cardSyncOwnerAuthorization.ownerCreatePairing>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerPairing> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerCreatePairing(ctx, input));
  }

  /** Cancelling an invitation, answered as `Pairing` (narrowing). */
  cancelCardSyncOwnerPairing(input: Parameters<typeof cardSyncOwnerAuthorization.ownerCancelPairing>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerPairing> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerCancelPairing(ctx, input));
  }

  /** Approval, with the rotation in its own transaction (§10 item 15), answered as `{pairing, device}` (widening). */
  approveCardSyncOwnerPairing(input: Parameters<typeof cardSyncOwnerAuthorization.ownerApprovePairing>[1]):
    CardSyncAuthChange<{ pairing: cardSyncOwnerAuthorization.OwnerPairing; device: cardSyncOwnerAuthorization.OwnerDevice }> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerApprovePairing(ctx, input));
  }

  /** Rejection, answered as `{pairing, device}` (narrowing). */
  rejectCardSyncOwnerPairing(input: Parameters<typeof cardSyncOwnerAuthorization.ownerRejectPairing>[1]):
    CardSyncAuthChange<{ pairing: cardSyncOwnerAuthorization.OwnerPairing; device: cardSyncOwnerAuthorization.OwnerDevice }> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerRejectPairing(ctx, input));
  }

  /** Revocation by the owner or a password reset, answered as `Device` (narrowing). */
  revokeCardSyncOwnerDevice(input: Parameters<typeof cardSyncOwnerAuthorization.ownerRevokeDevice>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerDevice> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerRevokeDevice(ctx, input));
  }

  /** Re-grant of stale bindings, answered as `Device` (widening). */
  regrantCardSyncOwnerDevice(input: Parameters<typeof cardSyncOwnerAuthorization.ownerRegrantDevice>[1]):
    CardSyncAuthChange<cardSyncOwnerAuthorization.OwnerDevice> {
    return this.syncWrite((ctx) => cardSyncOwnerAuthorization.ownerRegrantDevice(ctx, input));
  }

  /** The browsers a password reset revokes: every one of the user's not yet revoked, expired ones included (§10 item 6). */
  listCardSyncDevicesToRevokeForReset(ownerRef: string): string[] {
    return this.syncRead((ctx) => cardSyncOwnerAuthorization.devicesToRevokeForReset(ctx, ownerRef));
  }

  /** What authority remains, as counts (§5.8: the recovery CLI's check before it opens the gate). */
  getCardSyncRemainingAuthority(): cardSyncOwnerAuthorization.CardSyncRemainingAuthority {
    return this.syncRead((ctx) => cardSyncOwnerAuthorization.remainingCardSyncAuthority(ctx));
  }

  /** One card-sync write: one IMMEDIATE transaction, the clock read once (§5.0). A refusal leaves nothing written. */
  private syncWrite<T>(write: (ctx: CardSyncContext) => T): T {
    return this.db.transaction(() => write(this.syncContext())).immediate();
  }

  /** A card-sync read of several statements: one deferred transaction, so they all see one snapshot. */
  private syncRead<T>(read: (ctx: CardSyncContext) => T): T {
    return this.db.transaction(() => read(this.syncContext()))();
  }

  /** A card-sync read: the clock read once, the statements prepared once per connection. */
  private syncContext(): CardSyncContext {
    this.syncStatements ??= new CardSyncStatements(this.db);
    return { db: this.db, now: this.now().toISOString(), statements: this.syncStatements, guardRevision: this.guardRevision };
  }

  /**
   * Posted rows that may be this pending row's posted version, for the owner
   * to judge: same card account, currency and amount, from another import,
   * dated 2 days before to 10 days after it; the same description first, then
   * the closest date. Nothing changes: issuers give a posted row a new
   * reference, and amount and dates alone cannot prove two rows are one
   * purchase. Empty for a row that is not pending.
   */
  listPossiblePostedCardVersions(id: string, limit = 3): CardTransaction[] {
    const pending = this.getCardTransaction(id);
    if (!pending || pending.status !== 'pending') return [];
    const rows = (this.db
      .prepare(
        `SELECT ${CARD_TRANSACTION_COLUMNS} FROM card_transactions
          WHERE card_account_id = ? AND currency = ? AND status = 'posted' AND amount_minor = ?
            AND transaction_date BETWEEN ? AND ? AND import_batch_id IS NOT ?
          ORDER BY rowid`,
      )
      .raw()
      .all(
        pending.cardAccountId,
        pending.currency,
        pending.amountMinor,
        shiftIsoDate(pending.transactionDate, -POSTED_MATCH_DAYS_BEFORE),
        shiftIsoDate(pending.transactionDate, POSTED_MATCH_DAYS_AFTER),
        pending.importBatchId ?? null,
      ) as CardTransactionValues[]).map(mapCardTransactionRow);
    const description = canonicalCardDescription(pending.description);
    const same = (row: CardTransaction) => Number(canonicalCardDescription(row.description) === description);
    const distance = (row: CardTransaction) => Math.abs(daysBetween(pending.transactionDate, row.transactionDate));
    return rows.sort((a, b) => same(b) - same(a) || distance(a) - distance(b)).slice(0, limit);
  }

  listCardTransactions(filter: CardTransactionFilter = {}): CardTransaction[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter.cardAccountId !== undefined) {
      conditions.push('card_account_id = ?');
      params.push(filter.cardAccountId);
    }
    if (filter.from !== undefined) {
      if (!isValidIsoDate(filter.from)) throw new HoldrRefusal('card transaction from date must be valid YYYY-MM-DD');
      conditions.push('transaction_date >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      if (!isValidIsoDate(filter.to)) throw new HoldrRefusal('card transaction to date must be valid YYYY-MM-DD');
      conditions.push('transaction_date <= ?');
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${CARD_TRANSACTION_COLUMNS} FROM card_transactions ${where} ORDER BY transaction_date, rowid`)
      .raw()
      .all(...params) as CardTransactionValues[];
    return rows.map(mapCardTransactionRow);
  }

  getCardImportBatch(id: string): CardImportBatch | null {
    const row = this.db
      .prepare(`SELECT ${CARD_IMPORT_BATCH_COLUMNS} FROM card_import_batches WHERE id = ?`)
      .get(id) as CardImportBatchRow | undefined;
    return row ? mapCardImportBatchRow(row) : null;
  }

  listCardImportBatches(cardAccountId?: string): CardImportBatch[] {
    const rows = (cardAccountId === undefined
      ? this.db
          .prepare(`SELECT ${CARD_IMPORT_BATCH_COLUMNS} FROM card_import_batches ORDER BY imported_at, rowid`)
          .all()
      : this.db
          .prepare(
            `SELECT ${CARD_IMPORT_BATCH_COLUMNS} FROM card_import_batches
             WHERE card_account_id = ? ORDER BY imported_at, rowid`,
          )
          .all(cardAccountId)) as CardImportBatchRow[];
    return rows.map(mapCardImportBatchRow);
  }

  getCardTransaction(id: string): CardTransaction | null {
    const row = this.db
      .prepare(`SELECT ${CARD_TRANSACTION_COLUMNS} FROM card_transactions WHERE id = ?`)
      .raw()
      .get(id) as CardTransactionValues | undefined;
    return row ? mapCardTransactionRow(row) : null;
  }

  /** One page of the rows matching `query`, and how many match in all. */
  queryCardTransactions(query: CardTransactionQuery = {}, page: CardTransactionPageRequest = {}): CardTransactionPage {
    const where = cardTransactionWhere(this.db, this.cardDetectors, query);
    const sort = page.sort ?? 'date-desc';
    const order = CARD_TRANSACTION_ORDER[sort];
    if (!order) throw new HoldrRefusal('sort must be date-desc, date-asc, amount-desc or amount-asc');
    const limit = page.limit ?? 50;
    const offset = page.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CARD_TRANSACTION_PAGE) {
      throw new HoldrRefusal(`limit must be an integer from 1 to ${MAX_CARD_TRANSACTION_PAGE}`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HoldrRefusal('offset must be a non-negative integer');
    const rows = this.db
      .prepare(`SELECT ${CARD_TRANSACTION_COLUMNS} FROM card_transactions ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .raw()
      .all(...where.params, limit, offset) as CardTransactionValues[];
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM card_transactions ${where.sql}`)
      .get(...where.params) as { n: number }).n;
    return { transactions: rows.map(mapCardTransactionRow), total };
  }

  /** Every row matching `query`, oldest first: the input of the spending summary. */
  listCardTransactionsMatching(query: CardTransactionQuery = {}): CardTransaction[] {
    const where = cardTransactionWhere(this.db, this.cardDetectors, query);
    const rows = this.db
      .prepare(`SELECT ${CARD_TRANSACTION_COLUMNS} FROM card_transactions ${where.sql} ORDER BY transaction_date, rowid`)
      .raw()
      .all(...where.params) as CardTransactionValues[];
    return rows.map(mapCardTransactionRow);
  }

  /** Every row matching `query`, in the order `queryCardTransactions` pages them, for a page cut after filtering. */
  listCardTransactionsSorted(query: CardTransactionQuery = {}, sort: CardTransactionSort = 'date-desc'): CardTransaction[] {
    const where = cardTransactionWhere(this.db, this.cardDetectors, query);
    const order = CARD_TRANSACTION_ORDER[sort];
    if (!order) throw new HoldrRefusal('sort must be date-desc, date-asc, amount-desc or amount-asc');
    const rows = this.db
      .prepare(`SELECT ${CARD_TRANSACTION_COLUMNS} FROM card_transactions ${where.sql} ORDER BY ${order}`)
      .raw()
      .all(...where.params) as CardTransactionValues[];
    return rows.map(mapCardTransactionRow);
  }

  /** Whether `name` could be stored as a custom category exactly as it is: the same guard as `userCategory`. */
  isAcceptableCardCategory(name: string): boolean {
    try {
      return cardText(this.cardDetectors, 'category', name, 100) === name;
    } catch (error) {
      if (error instanceof HoldrRefusal) return false;
      throw error;
    }
  }

  /** A category filter as the card transaction queries compare it (and refuse it): the stored categories' spelling. */
  cardCategoryFilterName(name: string): string {
    return cardText(this.cardDetectors, 'category', name, 100);
  }

  /** Custom and issuer categories in use, sorted; suggestions for picking a custom category. */
  listCardCategories(): string[] {
    const rows = this.db
      .prepare(
        `SELECT user_category AS category FROM card_transactions WHERE user_category IS NOT NULL
         UNION
         SELECT issuer_category FROM card_transactions WHERE issuer_category IS NOT NULL
         ORDER BY category`,
      )
      .all() as Array<{ category: string }>;
    return rows.map((row) => row.category);
  }

  /**
   * Set or clear a row's custom category and notes, dismiss a pending row or
   * restore one (see CardTransactionPatch). Amounts, dates, kinds and every
   * imported field stay as imported. Returns null when the row does not exist.
   */
  updateCardTransaction(id: string, patch: CardTransactionPatch, ctx: CardTransactionChangeContext): CardTransaction | null {
    if (!patch || typeof patch !== 'object') throw new HoldrRefusal('card transaction patch must be an object');
    const actor = sessionActor(ctx?.actorRef);
    const update = this.db.transaction((): CardTransaction | null => {
      const current = this.getCardTransaction(id);
      if (!current) return null;
      if (patch.postedAs !== undefined) {
        // The owner's word that this pending row posted as that posted row: the
        // pending row is dismissed and kept (its identity still answers for it),
        // and its custom category and notes fill the posted row's empty ones.
        if (patch.status !== undefined || patch.userCategory !== undefined || patch.notes !== undefined) {
          throw new HoldrRefusal('postedAs cannot be combined with other changes');
        }
        if (typeof patch.postedAs !== 'string' || !CARD_ROW_ID.test(patch.postedAs)) {
          throw new HoldrRefusal('postedAs must be a card transaction id');
        }
        if (current.status !== 'pending') {
          throw new HoldrRefusal('only a pending card transaction can be matched to its posted row');
        }
        const posted = this.getCardTransaction(patch.postedAs);
        if (!posted || posted.status !== 'posted' || posted.cardAccountId !== current.cardAccountId
          || posted.currency !== current.currency) {
          throw new HoldrRefusal('postedAs must be a posted transaction of the same card account and currency');
        }
        const writer = new CardLedgerWriter(this.db, this.now().toISOString());
        writer.dismissAsPostedElsewhere({ transactionId: current.id, postedId: posted.id, actor });
        writer.finish();
        return this.getCardTransaction(current.id);
      }
      const userCategory = patch.userCategory === undefined
        ? current.userCategory ?? null
        : optionalCardText(this.cardDetectors, 'userCategory', patch.userCategory, 100) ?? null;
      const notes = patch.notes === undefined
        ? current.notes ?? null
        : optionalCardText(this.cardDetectors, 'notes', patch.notes, 1000) ?? null;
      let status: CardTransactionStatus = current.status;
      if (patch.status === 'removed') {
        if (current.status === 'pending') {
          status = 'removed';
        } else if (current.status !== 'removed') {
          throw new HoldrRefusal('only a pending card transaction can be dismissed');
        }
      } else if (patch.status === 'pending') {
        if (current.status === 'removed' && current.dismissedAt !== undefined && current.dismissedAt !== null) {
          status = 'pending';
        } else if (current.status !== 'pending') {
          throw new HoldrRefusal('only a dismissed pending card transaction can be restored');
        }
      } else if (patch.status !== undefined) {
        throw new HoldrRefusal('status must be pending or removed');
      }
      const writer = new CardLedgerWriter(this.db, this.now().toISOString());
      writer.editOwnerFields({ transactionId: id, userCategory, notes, status, actor });
      writer.finish();
      return this.getCardTransaction(id);
    });
    return update.immediate();
  }

  /** Per card account: imports, merged coverage ranges and the stored date range. */
  listCardCoverage(): CardAccountCoverage[] {
    const batches = this.listCardImportBatches();
    const stats = new Map(
      (this.db
        .prepare(
          `SELECT card_account_id, COUNT(*) AS n, MIN(transaction_date) AS first, MAX(transaction_date) AS last
             FROM card_transactions WHERE status <> 'removed' GROUP BY card_account_id`,
        )
        .all() as Array<{ card_account_id: string; n: number; first: string; last: string }>)
        .map((row) => [row.card_account_id, { count: row.n, first: row.first, last: row.last }]),
    );
    return this.listCardAccounts().map((account) => {
      const imports = batches.filter((batch) => batch.cardAccountId === account.id);
      return {
        cardAccountId: account.id,
        ranges: mergeCardCoverage(imports.flatMap((batch) => (batch.coverage ? [batch.coverage] : []))),
        transactions: stats.get(account.id) ?? null,
        imports: imports.reverse(),
      };
    });
  }

  /** True when the card account's recorded imports already cover every day of `coverage`. */
  cardCoverageCovers(cardAccountId: string, coverage: { start: string; end: string }): boolean {
    const ranges = this.listCardImportBatches(cardAccountId).flatMap((batch) => (batch.coverage ? [batch.coverage] : []));
    return cardCoverageContains(ranges, coverage);
  }

  // -------------------------------------------------------------------------
  // Card benefits (services/cardBenefits.ts): settings per card account,
  // manual marks, issuer-reported trackers, and the posted credits the
  // Benefits tab matches. Behind the value-free boundary like every card method.
  // -------------------------------------------------------------------------

  private benefitsStore(): CardBenefitsStore {
    return new CardBenefitsStore(this.db, this.now, (id) => this.getCardAccount(id), this.benefits);
  }

  /** The benefits catalog this repository validates settings and marks against. */
  benefitsCatalog(): BenefitCatalog {
    return this.benefits;
  }

  listCardBenefitSettings(): CardBenefitSettings[] {
    return this.benefitsStore().listSettings();
  }

  /** The card account's product choice and anniversary month (left out, the month stays). */
  setCardBenefitSettings(cardAccountId: string, input: CardBenefitSettingsInput): CardBenefitSettings {
    return this.benefitsStore().setSettings(cardAccountId, input);
  }

  listCardBenefitMarks(): CardBenefitMark[] {
    return this.benefitsStore().listMarks();
  }

  setCardBenefitMark(input: CardBenefitMarkInput): CardBenefitMark {
    return this.benefitsStore().setMark(input);
  }

  /** True when a mark was removed. */
  clearCardBenefitMark(key: CardBenefitMarkKey): boolean {
    return this.benefitsStore().clearMark(key);
  }

  /**
   * Issuer-reported benefit trackers for one card account (contract v1 in
   * the shared cardBenefits/issuerTrackers.ts), all or nothing. The capture's
   * receiver resolves the card through its confirmed card-sync binding first.
   */
  recordCardBenefitTrackers(input: { cardAccountId: string; snapshots: unknown }): CardBenefitTrackerResult {
    return this.benefitsStore().recordTrackers(input);
  }

  listCardBenefitTrackers(): IssuerBenefitTrackerRecord[] {
    return this.benefitsStore().listTrackers();
  }

  /** Posted credits (and credits taken back) dated from `from` to `to`, for benefit matching. */
  listCardBenefitCredits(from: string, to: string): BenefitCreditRow[] {
    return this.benefitsStore().listCredits(from, to);
  }

  // -------------------------------------------------------------------------
  // Owner spending rules (services/cardSpendingRules.ts): "<class> purchases of
  // at least <amount> are precious metals". Their table is installed only by
  // the Root-GO-gated operator command, never here: every read works without
  // it (no rules), and a write refuses (CARD_SPENDING_RULES_NOT_INSTALLED).
  // -------------------------------------------------------------------------

  /** Whether the owner rules' table is installed, in the expected shape. */
  cardSpendingRulesInstalled(): boolean {
    return cardSpendingRulesSchemaState(this.db) === 'present';
  }

  /** Every owner rule, revoked ones too, oldest first; none while the table is not installed. */
  listCardSpendingRules(): CardSpendingRule[] {
    return listSpendingRules(this.db);
  }

  /**
   * Whether any card row can be an asset purchase now (shared cardSpendingExclusions.ts): a row of any status the owner
   * filed under the asset category, however it is spelled, or an owner rule in force (none while the rules' table is
   * not installed). When none can, Spending's answers skip the exclusion pass and are exactly the answers before
   * asset purchases. One read of the categories in use; no row is materialized.
   */
  cardSpendingAssetsPossible(): boolean {
    const categories = this.db
      .prepare('SELECT DISTINCT user_category AS category FROM card_transactions WHERE user_category IS NOT NULL')
      .all() as Array<{ category: string }>;
    return categories.some((row) => isCardAssetCategory(row.category))
      || listSpendingRules(this.db).some((rule) => rule.revokedAt === null);
  }

  /** A new owner rule, by the signed-in owner (`actorRef`). */
  createCardSpendingRule(
    input: { merchantClass: unknown; currency: unknown; minAmountMinor: unknown },
    ctx: { actorRef: string },
  ): CardSpendingRule {
    return createSpendingRule(this.db, input, { actorRef: ctx.actorRef, now: this.now().toISOString() });
  }

  /** Revokes an owner rule (kept, with when and by whom); null when there is no such rule. */
  revokeCardSpendingRule(id: unknown, ctx: { actorRef: string }): CardSpendingRule | null {
    return revokeSpendingRule(this.db, id, { actorRef: ctx.actorRef, now: this.now().toISOString() });
  }

  // -------------------------------------------------------------------------
  // Card opening months (services/cardOpeningMonths.ts): "this card was opened
  // in <month>", so coverage stops expecting a card before it. Their table is
  // installed only by the Root-GO-gated operator command, never here: every
  // read works without it (no months), and a write refuses
  // (CARD_OPENING_MONTHS_NOT_INSTALLED).
  // -------------------------------------------------------------------------

  /** Whether the opening months' table is installed, in the expected shape. */
  cardOpeningMonthsInstalled(): boolean {
    return cardOpeningMonthsSchemaState(this.db) === 'present';
  }

  /** Every confirmation of an opening month, ended ones too, oldest first; none while the table is not installed. */
  listCardOpeningMonths(): CardOpeningMonthRecord[] {
    return listOpeningMonths(this.db);
  }

  /**
   * Confirms opening months, all or nothing, by the signed-in owner (`actorRef`). `firstKnownDays` reads each card's
   * first known day as coverage reads it; the store calls it inside its write transaction (one definition).
   */
  confirmCardOpeningMonths(
    input: unknown,
    ctx: { actorRef: string },
    firstKnownDays: CardFirstKnownDays,
  ): { changed: number; unchanged: number } {
    return confirmOpeningMonths(this.db, input, { actorRef: ctx.actorRef, now: this.now().toISOString() }, firstKnownDays);
  }

  /** Ends a card's month in force (kept, with when and by whom): false when none was, null for no such card. */
  clearCardOpeningMonth(cardAccountId: unknown, ctx: { actorRef: string }): boolean | null {
    return clearOpeningMonth(this.db, cardAccountId, { actorRef: ctx.actorRef, now: this.now().toISOString() });
  }

  // -------------------------------------------------------------------------
  // Card payment decisions (services/cardPaymentDecisions.ts): the owner's word
  // on which checking debit paid a card payment. Their table is installed only
  // by the Root-GO-gated operator command, never here: every read works
  // without it (no decisions), and a decision refuses
  // (CARD_PAYMENT_DECISIONS_NOT_INSTALLED).
  // -------------------------------------------------------------------------

  /** Whether the card payment decisions' table is installed, in the expected shape. */
  cardPaymentDecisionsInstalled(): boolean {
    return cardPaymentDecisionsSchemaState(this.db) === 'present';
  }

  /** The card payment decisions' table: `present` (this build's shape), `absent`, or `conflict` (anything else). */
  cardPaymentDecisionsSchemaState(): CardPaymentDecisionsSchemaState {
    return cardPaymentDecisionsSchemaState(this.db);
  }

  /** Decisions in force (every one with `includeRevoked`), oldest first; none while the table is not installed. */
  listCardPaymentDecisions(options: { includeRevoked?: boolean } = {}): CardPaymentDecisionRecord[] {
    return listPaymentDecisions(this.db, options);
  }

  /** A new decision by the signed-in owner (`actorRef`), on rows the caller has checked. */
  recordCardPaymentDecision(input: CardPaymentDecisionInput, ctx: { actorRef: string }): CardPaymentDecisionRecord {
    return recordPaymentDecision(this.db, input, { actorRef: ctx.actorRef, now: this.now().toISOString() });
  }

  /** Undoes a decision (kept, with when and by whom); null when there is no such decision. */
  revokeCardPaymentDecision(id: unknown, ctx: { actorRef: string }): CardPaymentDecisionRecord | null {
    return revokePaymentDecision(this.db, id, { actorRef: ctx.actorRef, now: this.now().toISOString() });
  }

  /** Diagnostic counts for `/health`. */
  counts(): { accounts: number; transactions: number } {
    const a = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
    const t = (this.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    return { accounts: a, transactions: t };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Internal: expose the underlying DB handle for sibling repositories
   * (e.g. AuthRepo) that share this DB file. Not for use outside the api
   * package; consumers should call the typed methods on this class.
   */
  internalGetDb(): DB {
    return this.db;
  }
}

/**
 * The card repository operations and the fixed names their failures carry.
 * Each runs behind the value-free boundary (dbErrors.ts): a failure leaves as
 * one of Holdr's own refusals, or as a HoldrDbError naming the operation and
 * SQLite's result code, never with SQLite's message. Every card method must
 * be listed here; a test checks.
 */
export const CARD_REPO_OPERATIONS = {
  createCardAccount: 'create card account',
  getCardAccount: 'read card account',
  listCardAccounts: 'list card accounts',
  updateCardAccount: 'update card account',
  previewCardImport: 'preview card import',
  commitCardImport: 'commit card import',
  importCardTransactions: 'import card transactions',
  listCardTransactions: 'list card transactions',
  getCardImportBatch: 'read card import batch',
  listCardImportBatches: 'list card import batches',
  getCardTransaction: 'read card transaction',
  queryCardTransactions: 'query card transactions',
  listCardTransactionsMatching: 'list matching card transactions',
  listCardTransactionsSorted: 'list sorted card transactions',
  listCardCategories: 'list card categories',
  isAcceptableCardCategory: 'check card category',
  cardCategoryFilterName: 'read card category filter',
  updateCardTransaction: 'update card transaction',
  listCardCoverage: 'list card coverage',
  cardCoverageCovers: 'check card coverage',
  listCardBenefitSettings: 'list card benefit settings',
  setCardBenefitSettings: 'set card benefit settings',
  listCardBenefitMarks: 'list card benefit marks',
  setCardBenefitMark: 'set card benefit mark',
  clearCardBenefitMark: 'clear card benefit mark',
  recordCardBenefitTrackers: 'record card benefit trackers',
  listCardBenefitTrackers: 'list card benefit trackers',
  listCardBenefitCredits: 'list card benefit credits',
  cardSpendingRulesInstalled: 'check card spending rules',
  listCardSpendingRules: 'list card spending rules',
  cardSpendingAssetsPossible: 'check card spending assets',
  createCardSpendingRule: 'create card spending rule',
  revokeCardSpendingRule: 'revoke card spending rule',
  cardOpeningMonthsInstalled: 'check card opening months',
  listCardOpeningMonths: 'list card opening months',
  confirmCardOpeningMonths: 'confirm card opening months',
  clearCardOpeningMonth: 'clear card opening month',
  cardPaymentDecisionsInstalled: 'check card payment decisions',
  cardPaymentDecisionsSchemaState: 'check card payment decisions',
  listCardPaymentDecisions: 'list card payment decisions',
  recordCardPaymentDecision: 'record card payment decision',
  revokeCardPaymentDecision: 'revoke card payment decision',
  listPossiblePostedCardVersions: 'list possible posted card versions',
  getCardSyncSettings: 'read card sync settings',
  pauseCardSync: 'pause card sync',
  resumeCardSync: 'resume card sync',
  enableCardSyncIssuer: 'enable card sync issuer',
  disableCardSyncIssuer: 'disable card sync issuer',
  updateCardSyncRetention: 'update card sync retention',
  getCardSyncAuthorizationGeneration: 'read card sync generation',
  listCardSourceBindings: 'list card source bindings',
  getCardSourceBinding: 'read card source binding',
  createCardSourceBinding: 'create card source binding',
  confirmCardSourceBinding: 'confirm card source binding',
  retireCardSourceBinding: 'retire card source binding',
  setCardSyncAutoSync: 'set card sync auto sync',
  createCardSyncPairing: 'create card sync pairing',
  cancelCardSyncPairing: 'cancel card sync pairing',
  getCardSyncPairing: 'read card sync pairing',
  listCardSyncPairings: 'list card sync pairings',
  redeemCardSyncPairing: 'redeem card sync pairing',
  cancelPendingCardSyncRedemption: 'cancel pending card sync redemption',
  approveCardSyncPairing: 'approve card sync pairing',
  rejectCardSyncPairing: 'reject card sync pairing',
  revokeCardSyncDevice: 'revoke card sync device',
  regrantCardSyncDevice: 'regrant card sync device',
  findCardSyncDeviceByTokenDigest: 'find card sync device',
  touchCardSyncDevice: 'touch card sync device',
  getCardSyncDevice: 'read card sync device',
  listCardSyncDevices: 'list card sync devices',
  createCardSyncRun: 'create card sync run',
  recordCardSyncRunRefusal: 'record card sync run refusal',
  abortCardSyncRun: 'abort card sync run',
  getCardSyncRun: 'read card sync run',
  getCardSyncRunByClientRunId: 'read card sync run by client id',
  getCardSyncRunReceipt: 'read card sync run receipt',
  listCardSyncRuns: 'list card sync runs',
  acceptCardSyncObservations: 'accept card sync observations',
  getCardSyncPayloadReceipt: 'read card sync payload receipt',
  deleteCardSyncReceipt: 'delete card sync receipt',
  rehydrateCardSyncPayload: 'rehydrate card sync payload',
  listCardSyncObservationSets: 'list card sync observation sets',
  getCardSyncObservationSetPage: 'read card sync observation set page',
  refreshCardReviewItems: 'refresh card review items',
  recordCardReviewDecisions: 'record card review decisions',
  discardCardSyncObservationSet: 'discard card sync observation set',
  prepareCardSyncPlan: 'prepare card sync plan',
  commitCardSyncPlan: 'commit card sync plan',
  getCardSyncPlanEffectsPage: 'read card sync plan effects page',
  removeCardTransaction: 'remove card transaction',
  restoreCardTransaction: 'restore card transaction',
  attributeCardTransaction: 'attribute card transaction',
  mergeCardTransactions: 'merge card transactions',
  unmergeCardTransaction: 'unmerge card transaction',
  detachCardSourceIdentity: 'detach card source identity',
  repointCardSourceIdentity: 'repoint card source identity',
  revertCardTransactionChange: 'revert card transaction change',
  getCardTransactionSources: 'read card transaction sources',
  listStalePendingCardTransactions: 'list stale pending card transactions',
  invalidateAllCardSyncAuthorization: 'invalidate card sync authorization',
  runCardSyncRetention: 'run card sync retention',
  checkpointAfterCardSyncRetention: 'checkpoint after card sync retention',
  listCardCoverageWindows: 'list card coverage windows',
  mergedCardCoverage: 'merge card coverage',
  listCardSyncOwnerSets: 'list card sync owner sets',
  getCardSyncOwnerSet: 'read card sync owner set',
  getCardSyncOwnerSetVersion: 'read card sync owner set version',
  recordCardSyncOwnerDecisions: 'record card sync owner decisions',
  prepareCardSyncOwnerPlan: 'prepare card sync owner plan',
  getCardSyncOwnerPlanEffects: 'read card sync owner plan effects',
  commitCardSyncOwnerPlan: 'commit card sync owner plan',
  discardCardSyncOwnerSet: 'discard card sync owner set',
  listCardSyncOwnerRuns: 'list card sync owner runs',
  getCardSyncOwnerRun: 'read card sync owner run',
  getCardSyncOwnerRunPayload: 'read card sync owner run payload',
  getCardSyncOwnerSources: 'read card sync owner sources',
  detachCardSyncOwnerIdentity: 'detach card sync owner identity',
  repointCardSyncOwnerIdentity: 'repoint card sync owner identity',
  revertCardSyncOwnerChange: 'revert card sync owner change',
  unmergeCardSyncOwnerTransaction: 'unmerge card sync owner transaction',
  getCardSyncOwnerState: 'read card sync owner state',
  getCardSyncOwnerAuthorityPage: 'read card sync owner authority page',
  getCardSyncOwnerBinding: 'read card sync owner binding',
  getCardSyncOwnerDevice: 'read card sync owner device',
  pauseCardSyncOwner: 'pause card sync for the owner',
  resumeCardSyncOwner: 'resume card sync for the owner',
  enableCardSyncOwnerIssuer: 'enable card sync owner issuer',
  disableCardSyncOwnerIssuer: 'disable card sync owner issuer',
  createCardSyncOwnerBinding: 'create card sync owner binding',
  confirmCardSyncOwnerBinding: 'confirm card sync owner binding',
  retireCardSyncOwnerBinding: 'retire card sync owner binding',
  setCardSyncOwnerAutoSync: 'set card sync owner auto sync',
  createCardSyncOwnerPairing: 'create card sync owner pairing',
  cancelCardSyncOwnerPairing: 'cancel card sync owner pairing',
  approveCardSyncOwnerPairing: 'approve card sync owner pairing',
  rejectCardSyncOwnerPairing: 'reject card sync owner pairing',
  revokeCardSyncOwnerDevice: 'revoke card sync owner device',
  regrantCardSyncOwnerDevice: 'regrant card sync owner device',
  listCardSyncDevicesToRevokeForReset: 'list card sync devices to revoke',
  getCardSyncRemainingAuthority: 'read card sync remaining authority',
} as const satisfies { readonly [Method in keyof SqliteStateRepo]?: string };

for (const method of Object.keys(CARD_REPO_OPERATIONS) as Array<keyof typeof CARD_REPO_OPERATIONS>) {
  const unguarded = SqliteStateRepo.prototype[method] as (this: SqliteStateRepo, ...args: never[]) => unknown;
  Object.defineProperty(SqliteStateRepo.prototype, method, {
    ...Object.getOwnPropertyDescriptor(SqliteStateRepo.prototype, method),
    value: withValueFreeDbErrors(CARD_REPO_OPERATIONS[method], unguarded),
  });
}

interface AccountNavRow {
  id: string;
  account_id: string;
  broker: string;
  observed_at: string;
  nav: number;
  currency: string;
  statement_period_start: string;
  statement_period_end: string;
  account_last4: string;
  source_document_hash: string;
  source_file_name: string | null;
  source_page: number;
  imported_at: string;
}

interface CashHistoryDbRow {
  account_id: string;
  as_of_date: string;
  cash_balance: number;
  currency: string;
  broker: string;
  account_last4: string;
  source_hash: string;
  method: string;
  imported_at: string;
}

class CashHistoryConflict extends Error {
  constructor(readonly result: CashHistoryImportResult) {
    super('cash history conflicts with stored balances');
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function newYorkDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function validateCashHistoryImport(input: CashHistoryImportInput, today: string): void {
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('cash history currency must be a three-letter uppercase code');
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.broker)) throw new Error('cash history broker must be a lowercase source slug');
  if (!/^\d{4}$/.test(input.accountLast4)) throw new Error('cash history accountLast4 must contain exactly four digits');
  if (!/^[a-f0-9]{64}$/.test(input.sourceHash)) throw new Error('cash history source hash must be 64 lowercase hex characters');
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.method)) throw new Error('cash history method must be a lowercase slug');
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 20_000) {
    throw new Error('cash history must contain between 1 and 20000 rows');
  }
  const seen = new Set<string>();
  // End-of-day balances exist only for completed New York days: a same-day
  // row could miss later trades, and a typo like 1900-01-01 would stretch
  // ALL history across decades.
  // Rows are named by position: their dates and balances are the request's.
  for (const [index, row] of input.rows.entries()) {
    if (!row || typeof row.date !== 'string' || !isValidIsoDate(row.date)) {
      throw new Error('cash history dates must be valid YYYY-MM-DD dates');
    }
    if (row.date < '1990-01-01' || row.date >= today) {
      throw new Error('cash history dates must be completed days from 1990-01-01 (no same-day or future rows)');
    }
    if (seen.has(row.date)) throw new Error(`cash history rows[${index}] duplicates an earlier row's date`);
    seen.add(row.date);
    if (typeof row.cashBalance !== 'number' || !Number.isFinite(row.cashBalance) || Math.abs(row.cashBalance) > 1e12) {
      throw new Error(`cash history rows[${index}].cashBalance must be a finite number`);
    }
  }
}

interface CashEventRow {
  id: string;
  account_id: string;
  event_date: string;
  event_type: CashEventType;
  amount: number;
  currency: string;
  broker: string;
  account_last4: string;
  description: string;
  source_fingerprint: string;
  imported_at: string;
}

function mapAccountNavRow(row: AccountNavRow): AccountNavObservation {
  return {
    id: row.id,
    accountId: row.account_id,
    broker: row.broker,
    observedAt: row.observed_at,
    nav: row.nav,
    currency: row.currency,
    statementPeriodStart: row.statement_period_start,
    statementPeriodEnd: row.statement_period_end,
    accountLast4: row.account_last4,
    sourceDocumentHash: row.source_document_hash,
    sourceFileName: row.source_file_name ?? undefined,
    sourcePage: row.source_page,
    importedAt: row.imported_at,
  };
}

function mapCashEventRow(row: CashEventRow): CashEvent {
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.event_date,
    eventType: row.event_type,
    amount: row.amount,
    currency: row.currency,
    broker: row.broker,
    accountLast4: row.account_last4,
    description: row.description,
    sourceFingerprint: row.source_fingerprint,
    importedAt: row.imported_at,
  };
}

function validateAccountNavObservation(input: AccountNavObservationInput): void {
  if (!input.id.trim()) throw new Error('NAV observation id is required');
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.broker)) {
    throw new Error('NAV broker must be a lowercase source slug');
  }
  if (!isValidIsoDate(input.observedAt)) {
    throw new Error('NAV observedAt must be a valid YYYY-MM-DD date');
  }
  if (!isValidIsoDate(input.statementPeriodStart)) {
    throw new Error('NAV statement period start must be a valid YYYY-MM-DD date');
  }
  if (!isValidIsoDate(input.statementPeriodEnd)) {
    throw new Error('NAV statement period end must be a valid YYYY-MM-DD date');
  }
  if (input.statementPeriodStart > input.statementPeriodEnd) {
    throw new Error('NAV statement period start must not be after period end');
  }
  if (input.observedAt !== input.statementPeriodEnd) {
    throw new Error('NAV observedAt must equal statement period end');
  }
  if (!Number.isFinite(input.nav)) {
    throw new Error('NAV value must be finite');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error('NAV currency must be a three-letter uppercase code');
  }
  if (!/^\d{4}$/.test(input.accountLast4)) {
    throw new Error('NAV accountLast4 must contain exactly four digits');
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceDocumentHash)) {
    throw new Error('NAV source document hash must be 64 lowercase hex characters');
  }
  if (!Number.isInteger(input.sourcePage) || input.sourcePage < 1) {
    throw new Error('NAV source page must be a positive integer');
  }
  if (
    input.sourceFileName !== undefined
    && (input.sourceFileName.length > 255 || /[\u0000-\u001f\u007f]/.test(input.sourceFileName))
  ) {
    throw new Error('NAV source file name is invalid');
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

const CASH_EVENT_TYPES = new Set<CashEventType>([
  'deposit', 'withdrawal', 'dividend', 'interest',
  'transfer', 'fee', 'tax', 'sweep',
]);

function validateCashEvent(input: CashEventInput): void {
  if (!isValidIsoDate(input.date)) throw new Error('cash event date must be a valid YYYY-MM-DD date');
  if (!CASH_EVENT_TYPES.has(input.eventType)) throw new Error('cash event type is invalid');
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new Error('cash event amount must be finite and non-zero');
  if (input.eventType === 'deposit' && input.amount <= 0) throw new Error('cash deposit amount must be positive');
  if (input.eventType === 'withdrawal' && input.amount >= 0) {
    throw new Error('cash withdrawal amount must be negative');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('cash event currency must be a three-letter uppercase code');
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.broker)) throw new Error('cash event broker must be a lowercase source slug');
  if (!/^\d{4}$/.test(input.accountLast4)) throw new Error('cash event accountLast4 must contain exactly four digits');
  const description = input.description.trim();
  if (!description || description.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    throw new Error('cash event description is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceFingerprint)) {
    throw new Error('cash event source fingerprint must be 64 lowercase hex characters');
  }
}

function cashEventId(accountId: string, fingerprint: string): string {
  return `cash-${createHash('sha256')
    .update(`${accountId}\0${fingerprint}`)
    .digest('hex')
    .slice(0, 24)}`;
}

/**
 * Letters-only ids (128 random bits as letter hex) never contain a digit run.
 * A UUID can: card detection flags roughly one random UUID in 840.
 */
function newCardId(prefix: 'card-acct' | 'card-txn' | 'card-import'): string {
  return `${prefix}-${toLetterHex(randomBytes(16))}`;
}

const CARD_OWNERS = new Set<CardOwner>(['alex', 'casey', 'joint']);
/** A stored row's id as the routes take it (`newCardId` makes them). */
const CARD_ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CARD_ACCOUNT_STATUSES = new Set<CardAccountStatus>(['active', 'closed']);
const CARD_TRANSACTION_STATUSES = new Set<CardTransactionStatus>(['pending', 'posted', 'removed']);
const CARD_TRANSACTION_KINDS = new Set<CardTransactionKind>([
  'purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other',
]);
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MAX_CARD_AMOUNT_MINOR = 999_999_999_999;
const MAX_CARD_IMPORT_ROWS = 10_000;

/**
 * `holdr_card_spending_kind(kind, amount_minor, description, merchant, user_category, issuer_category)`: the kind
 * Spending reads a stored row as (shared `effectiveCardKind`). A value of any other type than the columns store is
 * passed through as the stored kind, as is a kind the rule does not know.
 */
function cardSpendingKindOf(
  kind: unknown, amountMinor: unknown, description: unknown, merchant: unknown, userCategory: unknown, issuerCategory: unknown,
): unknown {
  if (typeof kind !== 'string' || !CARD_TRANSACTION_KINDS.has(kind as CardTransactionKind)) return kind;
  const amount = typeof amountMinor === 'bigint' ? Number(amountMinor) : amountMinor;
  if (typeof amount !== 'number' || typeof description !== 'string') return kind;
  return effectiveCardKind({
    kind: kind as CardTransactionKind,
    amountMinor: amount,
    description,
    merchant: typeof merchant === 'string' ? merchant : null,
    userCategory: typeof userCategory === 'string' ? userCategory : null,
    issuerCategory: typeof issuerCategory === 'string' ? issuerCategory : null,
  });
}

/**
 * The WHERE clause and parameters for a card transaction query. Called only
 * from card repository methods, so it runs behind their value-free boundary;
 * its refusals are HoldrRefusals naming the field.
 */
function cardTransactionWhere(db: DB, detectors: CardDetectors, query: CardTransactionQuery): { sql: string; params: unknown[] } {
  if (!query || typeof query !== 'object') throw new HoldrRefusal('card transaction query must be an object');
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.cardAccountId !== undefined) {
    conditions.push('card_account_id = ?');
    params.push(query.cardAccountId);
  }
  if (query.owner !== undefined) {
    if (!CARD_OWNERS.has(query.owner)) throw new HoldrRefusal('owner must be alex, casey or joint');
    conditions.push('card_account_id IN (SELECT id FROM card_accounts WHERE owner = ?)');
    params.push(query.owner);
  }
  const statuses = query.statuses ?? ['pending', 'posted'];
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => !CARD_TRANSACTION_STATUSES.has(status))) {
    throw new HoldrRefusal('statuses must be pending, posted or removed');
  }
  conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
  params.push(...statuses);
  if (query.kinds !== undefined) {
    if (!Array.isArray(query.kinds) || query.kinds.length === 0 || query.kinds.some((kind) => !CARD_TRANSACTION_KINDS.has(kind))) {
      throw new HoldrRefusal('kinds must be card transaction kinds');
    }
    conditions.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
    params.push(...query.kinds);
  }
  if (query.spendingKinds !== undefined) {
    if (!Array.isArray(query.spendingKinds) || query.spendingKinds.length === 0
      || query.spendingKinds.some((kind) => !CARD_TRANSACTION_KINDS.has(kind))) {
      throw new HoldrRefusal('kinds must be card transaction kinds');
    }
    // Exactly the rule Spending reads rows with (shared effectiveCardKind), so a page is cut after it.
    conditions.push(`holdr_card_spending_kind(kind, amount_minor, description, merchant, user_category, issuer_category) IN (${
      query.spendingKinds.map(() => '?').join(', ')})`);
    params.push(...query.spendingKinds);
  }
  if (query.category !== undefined) {
    conditions.push('COALESCE(user_category, issuer_category, ?) = ?');
    params.push(CARD_UNCATEGORIZED, cardText(detectors, 'category', query.category, 100));
  }
  if (query.merchant !== undefined) {
    // Use exactly the same membership rule as summaries and insights.
    const key = cardMerchantKey(cardText(detectors, 'merchant', query.merchant, 500));
    conditions.push('holdr_merchant_matches(holdr_merchant_key(COALESCE(merchant, description)), ?) = 1');
    params.push(key);
  }
  if (query.search !== undefined) {
    const text = cardText(detectors, 'search', query.search, 100);
    // SQLite's lower() folds ASCII only; fold the needle the same way.
    const needle = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const matches = ['description', 'merchant', 'user_category', 'issuer_category', 'notes']
      .map((column) => `instr(lower(COALESCE(${column}, '')), ?) > 0`);
    params.push(...matches.map(() => needle));
    const currencies = (db.prepare('SELECT DISTINCT currency FROM card_accounts ORDER BY currency').all() as Array<{ currency: string }>)
      .map((row) => row.currency);
    for (const currency of currencies) {
      const minor = parseCardAmountQuery(text, currency);
      if (minor === null) continue;
      matches.push('(currency = ? AND abs(amount_minor) = ?)');
      params.push(currency, minor);
    }
    conditions.push(`(${matches.join(' OR ')})`);
  }
  for (const [bound, value, operator] of [['from', query.from, '>='], ['to', query.to, '<=']] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !isValidIsoDate(value)) throw new HoldrRefusal(`${bound} must be a valid YYYY-MM-DD date`);
    conditions.push(`transaction_date ${operator} ?`);
    params.push(value);
  }
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    throw new HoldrRefusal('from must not be after to');
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params };
}

/**
 * Free text bound for a card table, stored normalized (NFKC, no invisible
 * characters, ASCII digits): trimmed, capped, and free of card numbers in any
 * grouping or script and of labeled security codes, PINs and expiry dates.
 */
function cardText(detectors: CardDetectors, field: string, value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new HoldrRefusal(`${field} must be a string`);
  const text = normalizeCardText(value).trim();
  if (!text) throw new HoldrRefusal(`${field} must not be empty`);
  if (text.length > maxLength) throw new HoldrRefusal(`${field} must be at most ${maxLength} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new HoldrRefusal(`${field} must not contain control characters`);
  if (detectors.containsCardData(text) || containsLongDigitRun(text)) {
    throw new HoldrRefusal(`${field} must not contain a card number or ${LONG_DIGIT_RUN} or more consecutive digits`);
  }
  if (detectors.containsCardSecret(text)) {
    throw new HoldrRefusal(`${field} must not contain a card security code, PIN or expiry date`);
  }
  return text;
}

function optionalCardText(
  detectors: CardDetectors, field: string, value: unknown, maxLength: number,
): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : cardText(detectors, field, value, maxLength);
}

function cardCode(detectors: CardDetectors, field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HoldrRefusal(`${field} is invalid`);
  return cardText(detectors, field, value, 64);
}

function isCardAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_CARD_AMOUNT_MINOR;
}

function validateCardAccountInput(
  input: CardAccountInput,
  detectors: CardDetectors,
): Omit<CardAccount, 'id' | 'createdAt' | 'updatedAt'> {
  if (!input || typeof input !== 'object') throw new HoldrRefusal('card account must be an object');
  const issuer = cardCode(detectors, 'issuer', input.issuer, CARD_SLUG);
  if (!CARD_OWNERS.has(input.owner)) throw new HoldrRefusal('owner must be alex, casey or joint');
  const nickname = optionalCardText(detectors, 'nickname', input.nickname, 80);
  if (input.last4 !== undefined && input.last4 !== null
    && (typeof input.last4 !== 'string' || !/^[0-9]{4}$/.test(input.last4))) {
    throw new HoldrRefusal('last4 must be exactly four digits');
  }
  const last5 = input.last5 === undefined || input.last5 === null || input.last5 === ''
    ? undefined
    : validLast5(input.last5, input.last4 ?? (typeof input.last5 === 'string' ? input.last5.slice(1) : undefined));
  const last4 = input.last4 ?? last5?.slice(1);
  const currency = cardCode(detectors, 'currency', input.currency, CURRENCY_CODE);
  const status = input.status ?? 'active';
  if (!CARD_ACCOUNT_STATUSES.has(status)) throw new HoldrRefusal('status must be active or closed');
  return { issuer, owner: input.owner, nickname, last4: last4 ?? undefined, last5, currency, status };
}

/** Five ASCII digits ending with `last4`, which must be known. */
function validLast5(value: unknown, last4: string | null | undefined): string {
  if (typeof value !== 'string' || !/^[0-9]{5}$/.test(value)) throw new HoldrRefusal('last5 must be exactly five digits');
  if (!last4 || value.slice(1) !== last4) throw new HoldrRefusal('last5 must end with the account\'s last four digits');
  return value;
}

function validateCardImport(
  input: CardImportInput,
  account: CardAccount,
  detectors: CardDetectors,
): {
  source: string;
  parserVersion: string;
  rejectedCount: number;
  coverage?: { start: string; end: string };
  rows: CardImportRow[];
  promoteFingerprintMatches: boolean;
  promoteDismissedMatches: boolean;
  insertFingerprintMatches: boolean;
  promoteFingerprintMatchRows: Set<number>;
  dismissPendingIds: string[];
} {
  const source = cardCode(detectors, 'source', input.source, CARD_SLUG);
  const parserVersion = cardCode(detectors, 'parserVersion', input.parserVersion, CARD_PARSER_VERSION);
  const rejectedCount = input.rejectedCount ?? 0;
  if (!Number.isSafeInteger(rejectedCount) || rejectedCount < 0 || rejectedCount > MAX_CARD_IMPORT_ROWS) {
    throw new HoldrRefusal(`rejectedCount must be an integer from 0 to ${MAX_CARD_IMPORT_ROWS}`);
  }
  const promoteFingerprintMatches = input.promoteFingerprintMatches ?? false;
  if (typeof promoteFingerprintMatches !== 'boolean') throw new HoldrRefusal('promoteFingerprintMatches must be true or false');
  const promoteDismissedMatches = input.promoteDismissedMatches ?? false;
  if (typeof promoteDismissedMatches !== 'boolean') throw new HoldrRefusal('promoteDismissedMatches must be true or false');
  const insertFingerprintMatches = input.insertFingerprintMatches ?? false;
  if (typeof insertFingerprintMatches !== 'boolean') throw new HoldrRefusal('insertFingerprintMatches must be true or false');
  if (promoteFingerprintMatches && insertFingerprintMatches) {
    throw new HoldrRefusal('a fingerprint match is either posted or inserted, not both');
  }
  const dismissPendingIds = input.dismissPendingIds ?? [];
  if (!Array.isArray(dismissPendingIds) || dismissPendingIds.length > MAX_CARD_IMPORT_ROWS
    || dismissPendingIds.some((id) => typeof id !== 'string' || !CARD_ROW_ID.test(id))) {
    throw new HoldrRefusal('dismissPendingIds must be a list of card transaction ids');
  }
  let coverage: { start: string; end: string } | undefined;
  if (input.coverage !== undefined && input.coverage !== null) {
    const { start, end } = input.coverage as { start?: unknown; end?: unknown };
    if (typeof start !== 'string' || !isValidIsoDate(start) || typeof end !== 'string' || !isValidIsoDate(end) || start > end) {
      throw new HoldrRefusal('coverage must be two valid YYYY-MM-DD dates, start first');
    }
    coverage = { start, end };
  }
  const minRows = coverage ? 0 : 1;
  if (!Array.isArray(input.rows) || input.rows.length < minRows || input.rows.length > MAX_CARD_IMPORT_ROWS) {
    throw new HoldrRefusal(`rows must contain between ${minRows} and ${MAX_CARD_IMPORT_ROWS} rows`);
  }
  const rows = input.rows.map((row, index) => validateCardImportRow(row, `rows[${index}]`, account.currency, detectors));
  if (coverage) {
    rows.forEach((row, index) => {
      const date = row.postedDate ?? row.transactionDate;
      if (date < coverage!.start || date > coverage!.end) throw new HoldrRefusal(`rows[${index}] falls outside coverage`);
    });
  }
  const promoteFingerprintMatchRows = input.promoteFingerprintMatchRows ?? [];
  if (!Array.isArray(promoteFingerprintMatchRows) || promoteFingerprintMatchRows.length > MAX_CARD_IMPORT_ROWS
    || promoteFingerprintMatchRows.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= rows.length)) {
    throw new HoldrRefusal('promoteFingerprintMatchRows must be a list of row indexes');
  }
  if (promoteFingerprintMatchRows.length > 0 && (promoteFingerprintMatches || insertFingerprintMatches)) {
    throw new HoldrRefusal('fingerprint matches are posted either all or row by row, not both');
  }
  return {
    source, parserVersion, rejectedCount, coverage, rows, promoteFingerprintMatches, promoteDismissedMatches,
    insertFingerprintMatches, promoteFingerprintMatchRows: new Set(promoteFingerprintMatchRows),
    dismissPendingIds: [...new Set(dismissPendingIds)],
  };
}

function validateCardImportRow(
  row: CardImportRow, at: string, currency: string, detectors: CardDetectors,
): CardImportRow {
  if (!row || typeof row !== 'object') throw new HoldrRefusal(`${at} must be an object`);
  const externalIdHash = row.externalIdHash ?? undefined;
  if (externalIdHash !== undefined && !isCardExternalIdHash(externalIdHash)) {
    throw new HoldrRefusal(`${at}.externalIdHash must come from cardExternalIdHash`);
  }
  if (typeof row.transactionDate !== 'string' || !isValidIsoDate(row.transactionDate)) {
    throw new HoldrRefusal(`${at}.transactionDate must be a valid YYYY-MM-DD date`);
  }
  const postedDate = row.postedDate ?? undefined;
  if (postedDate !== undefined && (typeof postedDate !== 'string' || !isValidIsoDate(postedDate))) {
    throw new HoldrRefusal(`${at}.postedDate must be a valid YYYY-MM-DD date`);
  }
  // v15 (Q22): an import declares what a source showed, pending or posted;
  // only an owner's decision removes a row.
  if (row.status !== 'pending' && row.status !== 'posted') throw new HoldrRefusal(`${at}.status must be pending or posted`);
  if (!CARD_TRANSACTION_KINDS.has(row.kind)) throw new HoldrRefusal(`${at}.kind is invalid`);
  if (!isCardAmount(row.amountMinor)) {
    throw new HoldrRefusal(`${at}.amountMinor must be whole minor units of at most ${MAX_CARD_AMOUNT_MINOR}`);
  }
  if (row.currency !== currency) throw new HoldrRefusal(`${at}.currency must match the card account currency`);
  const originalAmountMinor = row.originalAmountMinor ?? undefined;
  const originalCurrency = row.originalCurrency ?? undefined;
  if ((originalAmountMinor === undefined) !== (originalCurrency === undefined)) {
    throw new HoldrRefusal(`${at}.originalAmountMinor and originalCurrency must be given together`);
  }
  if (originalAmountMinor !== undefined && !isCardAmount(originalAmountMinor)) {
    throw new HoldrRefusal(`${at}.originalAmountMinor must be whole minor units of at most ${MAX_CARD_AMOUNT_MINOR}`);
  }
  if (originalCurrency !== undefined && (typeof originalCurrency !== 'string' || !CURRENCY_CODE.test(originalCurrency))) {
    throw new HoldrRefusal(`${at}.originalCurrency must be a three-letter uppercase code`);
  }
  return {
    externalIdHash,
    transactionDate: row.transactionDate,
    postedDate,
    status: row.status,
    amountMinor: row.amountMinor,
    currency,
    originalAmountMinor,
    originalCurrency,
    kind: row.kind,
    description: cardText(detectors, `${at}.description`, row.description, 500),
    merchant: optionalCardText(detectors, `${at}.merchant`, row.merchant, 200),
    issuerCategory: optionalCardText(detectors, `${at}.issuerCategory`, row.issuerCategory, 100),
  };
}

const CARD_ACCOUNT_COLUMNS = 'id, issuer, owner, nickname, last4, last5, currency, status, created_at, updated_at';

interface CardAccountRow {
  id: string;
  issuer: string;
  owner: CardOwner;
  nickname: string | null;
  last4: string | null;
  last5: string | null;
  currency: string;
  status: CardAccountStatus;
  created_at: string;
  updated_at: string;
}

function mapCardAccountRow(row: CardAccountRow): CardAccount {
  return {
    id: row.id,
    issuer: row.issuer,
    owner: row.owner,
    nickname: row.nickname ?? undefined,
    last4: row.last4 ?? undefined,
    ...(row.last5 !== null ? { last5: row.last5 } : {}),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The card_transactions columns every card read selects, in this order. Card reads take raw rows, arrays of these
 * columns' values, which better-sqlite3 builds in about half the time named rows take; mapCardTransactionRow finds each
 * value by its column's name.
 */
const CARD_TRANSACTION_COLUMN_NAMES = [
  'id', 'card_account_id', 'source', 'external_id_hash', 'fingerprint', 'transaction_date',
  'posted_date', 'status', 'amount_minor', 'currency', 'original_amount_minor', 'original_currency', 'kind', 'description',
  'merchant', 'issuer_category', 'user_category', 'notes', 'import_batch_id', 'dismissed_at',
  'created_at', 'updated_at',
] as const;

const CARD_TRANSACTION_COLUMNS = CARD_TRANSACTION_COLUMN_NAMES.join(', ');

/** Where each column's value is in a raw card_transactions row. */
const CARD_TRANSACTION_COLUMN_AT = Object.fromEntries(CARD_TRANSACTION_COLUMN_NAMES.map((name, index) => [name, index])) as
  Readonly<Record<(typeof CARD_TRANSACTION_COLUMN_NAMES)[number], number>>;

const CARD_TRANSACTION_ORDER: Readonly<Record<CardTransactionSort, string>> = {
  'date-desc': 'transaction_date DESC, rowid DESC',
  'date-asc': 'transaction_date ASC, rowid ASC',
  'amount-desc': 'amount_minor DESC, transaction_date DESC, rowid DESC',
  'amount-asc': 'amount_minor ASC, transaction_date DESC, rowid DESC',
};

/** A pending row's possible posted versions are dated from this many days before it … */
const POSTED_MATCH_DAYS_BEFORE = 2;
/** … to this many days after it. */
const POSTED_MATCH_DAYS_AFTER = 10;

/** A v1 dedupe key as stored: the `xid1:` hash of the issuer reference, or the `cfp1:` fingerprint. */
function dedupeKeyValue(key: CardDedupeKey): string {
  return 'externalIdHash' in key ? key.externalIdHash : key.fingerprint;
}

/** A validated v1 import row as the ledger writer stores it. */
/** Thrown inside a commit's savepoint when the import would store nothing new: rolls it back (§4.10.4). */
const NOTHING_NEW = Symbol('card import: nothing new');

function sameIndexes(found: readonly number[], shown: readonly number[] | undefined): boolean {
  return shown !== undefined && found.length === shown.length && found.every((index, i) => index === shown[i]);
}

function sameIds(found: readonly string[], shown: readonly string[] | undefined): boolean {
  if (shown === undefined || found.length !== shown.length) return false;
  const expected = new Set(shown);
  return found.every((id) => expected.has(id));
}

/** A v1 payload row's values as the ledger stores them (a v1 row has no original amount). */
function payloadRowValues(row: CardImportPayloadRow): FileRowValues {
  return {
    transactionDate: row.transactionDate, postedDate: row.postedDate, status: row.status as 'pending' | 'posted',
    amountMinor: row.amountMinor, originalAmountMinor: null, originalCurrency: null, kind: row.kind, description: row.description,
    merchant: row.merchant, issuerCategory: row.issuerCategory,
  };
}

function fileRowValues(row: CardImportRow): FileRowValues {
  return {
    transactionDate: row.transactionDate,
    postedDate: row.postedDate ?? null,
    status: row.status as 'pending' | 'posted',
    amountMinor: row.amountMinor,
    originalAmountMinor: row.originalAmountMinor ?? null,
    originalCurrency: row.originalCurrency ?? null,
    kind: row.kind,
    description: row.description,
    merchant: row.merchant ?? null,
    issuerCategory: row.issuerCategory ?? null,
  };
}

function shiftIsoDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A card_transactions row read raw: the values of CARD_TRANSACTION_COLUMNS, in that order. */
type CardTransactionValues = readonly unknown[];

/** A card row from its raw values; a NULL column's field is kept, as undefined. */
function mapCardTransactionRow(row: CardTransactionValues): CardTransaction {
  const at = CARD_TRANSACTION_COLUMN_AT;
  return {
    id: row[at.id] as string,
    cardAccountId: row[at.card_account_id] as string,
    source: row[at.source] as string,
    externalIdHash: (row[at.external_id_hash] ?? undefined) as string | undefined,
    fingerprint: (row[at.fingerprint] ?? undefined) as string | undefined,
    transactionDate: row[at.transaction_date] as string,
    postedDate: (row[at.posted_date] ?? undefined) as string | undefined,
    status: row[at.status] as CardTransactionStatus,
    amountMinor: row[at.amount_minor] as number,
    currency: row[at.currency] as string,
    originalAmountMinor: (row[at.original_amount_minor] ?? undefined) as number | undefined,
    originalCurrency: (row[at.original_currency] ?? undefined) as string | undefined,
    kind: row[at.kind] as CardTransactionKind,
    description: row[at.description] as string,
    merchant: (row[at.merchant] ?? undefined) as string | undefined,
    issuerCategory: (row[at.issuer_category] ?? undefined) as string | undefined,
    userCategory: (row[at.user_category] ?? undefined) as string | undefined,
    notes: (row[at.notes] ?? undefined) as string | undefined,
    importBatchId: (row[at.import_batch_id] ?? undefined) as string | undefined,
    dismissedAt: (row[at.dismissed_at] ?? undefined) as string | undefined,
    createdAt: row[at.created_at] as string,
    updatedAt: row[at.updated_at] as string,
  };
}

const CARD_IMPORT_BATCH_COLUMNS = `id, card_account_id, source, parser_version, row_count, new_count,
  duplicate_count, rejected_count, coverage_start, coverage_end, imported_at`;

interface CardImportBatchRow {
  id: string;
  card_account_id: string;
  source: string;
  parser_version: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  rejected_count: number;
  coverage_start: string | null;
  coverage_end: string | null;
  imported_at: string;
}

function mapCardImportBatchRow(row: CardImportBatchRow): CardImportBatch {
  return {
    id: row.id,
    cardAccountId: row.card_account_id,
    source: row.source,
    parserVersion: row.parser_version,
    rowCount: row.row_count,
    newCount: row.new_count,
    duplicateCount: row.duplicate_count,
    rejectedCount: row.rejected_count,
    ...(row.coverage_start !== null && row.coverage_end !== null
      ? { coverage: { start: row.coverage_start, end: row.coverage_end } }
      : {}),
    importedAt: row.imported_at,
  };
}

/** For upgrade tests only: the card tables exactly as v13 created them, before the v14 columns. */
export const CARD_SPENDING_V13_SCHEMA_FOR_TESTS = CARD_SCHEMA_SQL;
/** For upgrade tests only: the v14 columns exactly as v14 added them to the v13 tables. */
export const CARD_REPORTS_V14_SCHEMA_FOR_TESTS = CARD_REPORTS_SCHEMA_SQL;

export type { CardSyncAuthChange } from './cardSync/principals.js';
export type { CardScopeDraft, CardScopeView, CardSourceBindingView, CardSyncHolderAlias } from './cardSync/bindings.js';
export type {
  CardSyncDeviceAuth, CardSyncDeviceGrantView, CardSyncDeviceStatus, CardSyncDeviceView, CardSyncPairingStatus, CardSyncPairingView,
  CardSyncRedeemResult, CardSyncRevokeActor, CardSyncRevokeReason,
} from './cardSync/devices.js';
export type {
  CardSyncAbortReason, CardSyncRunCursor, CardSyncRunRefusal, CardSyncRunState, CardSyncRunView,
} from './cardSync/runs.js';
export type {
  CardSyncGenerationStep, CardSyncIssuerSettings, CardSyncQuotas, CardSyncSettings,
} from './cardSync/settings.js';
export type { CardSyncAcceptanceReceipt } from './cardSync/acceptance.js';
export type {
  CardReviewDecisionInput, CardSyncDiscardReason, CardSyncReviewItemView, CardSyncSetCounts, CardSyncSetPage, CardSyncSetPageCursor,
  CardSyncSetSummary,
} from './cardSync/review.js';
export type { CardSyncCommitResult, CardSyncOwnerReview, CardSyncPlanEffect, CardSyncPlanView } from './cardSync/plans.js';
export type { CardLedgerRowView, CardTransactionSources } from './cardSync/ledger.js';
export type { CardSyncRecoveryReport } from './cardSync/recovery.js';
export type { CardSyncRetentionReport } from './cardSync/retention.js';
export type { CardCoverageSpan, CardCoverageWindowView } from './cardSync/coverage.js';
export { isDismissedPending, isPromotablePending, type StoredCardKey } from './cardImport/plan.js';
