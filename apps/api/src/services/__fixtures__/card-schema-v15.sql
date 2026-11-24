-- Holdr card schema (E1b design §3.6 golden file): every card object in sqlite_master by type and name, then per card
-- table its table_xinfo, foreign_key_list, index_list and index_xinfo, then user_version. Fresh and upgraded databases
-- must dump exactly this. Regenerate with `npx vitest run src/services/sqliteStateRepo.cardSync.test.ts -u`, and review.
-- Guard triggers (generated, pinned by the guard tripwire) appear as the SHA-256 of their SQL.

-- index idx_card_accounts_fk_currency on card_accounts
CREATE UNIQUE INDEX idx_card_accounts_fk_currency ON card_accounts(id, currency);

-- index idx_card_accounts_fk_issuer_currency on card_accounts
CREATE UNIQUE INDEX idx_card_accounts_fk_issuer_currency ON card_accounts(id, issuer, currency);

-- index idx_card_accounts_identity on card_accounts
CREATE INDEX idx_card_accounts_identity ON card_accounts(issuer, owner, last4);

-- index idx_card_coverage_windows_batch on card_coverage_windows
CREATE UNIQUE INDEX idx_card_coverage_windows_batch ON card_coverage_windows(import_batch_id);

-- index idx_card_coverage_windows_scope on card_coverage_windows
CREATE INDEX idx_card_coverage_windows_scope ON card_coverage_windows(card_account_id, card_scope_id, status);

-- index idx_card_coverage_windows_set_entry on card_coverage_windows
CREATE UNIQUE INDEX idx_card_coverage_windows_set_entry ON card_coverage_windows(observation_set_id, entry_ordinal);

-- index idx_card_coverage_windows_set_scope on card_coverage_windows
CREATE UNIQUE INDEX idx_card_coverage_windows_set_scope ON card_coverage_windows(observation_set_id, card_scope_id, status)
  WHERE observation_set_id IS NOT NULL;

-- index idx_card_import_batches_account on card_import_batches
CREATE INDEX idx_card_import_batches_account ON card_import_batches(card_account_id, imported_at);

-- index idx_card_import_batches_fk_account on card_import_batches
CREATE UNIQUE INDEX idx_card_import_batches_fk_account ON card_import_batches(id, card_account_id);

-- index idx_card_observation_secondary_ids_namespace on card_observation_secondary_ids
CREATE UNIQUE INDEX idx_card_observation_secondary_ids_namespace ON card_observation_secondary_ids(observation_id, namespace);

-- index idx_card_observation_secondary_ids_ordinal on card_observation_secondary_ids
CREATE UNIQUE INDEX idx_card_observation_secondary_ids_ordinal ON card_observation_secondary_ids(observation_id, ordinal);

-- index idx_card_payment_links_confirmed_payment on card_payment_links
CREATE UNIQUE INDEX idx_card_payment_links_confirmed_payment ON card_payment_links(card_transaction_id) WHERE decision = 'confirmed';

-- index idx_card_payment_links_confirmed_source on card_payment_links
CREATE UNIQUE INDEX idx_card_payment_links_confirmed_source ON card_payment_links(cash_event_ref) WHERE decision = 'confirmed';

-- index idx_card_payment_links_pair on card_payment_links
CREATE UNIQUE INDEX idx_card_payment_links_pair ON card_payment_links(card_transaction_id, cash_event_ref);

-- index idx_card_reconciliation_candidates_target on card_reconciliation_candidates
CREATE UNIQUE INDEX idx_card_reconciliation_candidates_target ON card_reconciliation_candidates(review_item_id, transaction_id);

-- index idx_card_reconciliation_candidates_transaction on card_reconciliation_candidates
CREATE INDEX idx_card_reconciliation_candidates_transaction ON card_reconciliation_candidates(transaction_id);

-- index idx_card_reconciliation_suggestions_committed on card_reconciliation_suggestions
CREATE INDEX idx_card_reconciliation_suggestions_committed ON card_reconciliation_suggestions(committed_transaction_id);

-- index idx_card_reconciliation_suggestions_fk_account on card_reconciliation_suggestions
CREATE UNIQUE INDEX idx_card_reconciliation_suggestions_fk_account ON card_reconciliation_suggestions(id, card_account_id);

-- index idx_card_reconciliation_suggestions_observation on card_reconciliation_suggestions
CREATE UNIQUE INDEX idx_card_reconciliation_suggestions_observation ON card_reconciliation_suggestions(observation_id);

-- index idx_card_reconciliation_suggestions_set on card_reconciliation_suggestions
CREATE INDEX idx_card_reconciliation_suggestions_set ON card_reconciliation_suggestions(observation_set_id, status);

-- index idx_card_reconciliation_suggestions_set_level on card_reconciliation_suggestions
CREATE UNIQUE INDEX idx_card_reconciliation_suggestions_set_level
  ON card_reconciliation_suggestions(observation_set_id) WHERE observation_id IS NULL;

-- index idx_card_scopes_account on card_scopes
CREATE INDEX idx_card_scopes_account ON card_scopes(card_account_id, kind, status);

-- index idx_card_scopes_fk_account on card_scopes
CREATE UNIQUE INDEX idx_card_scopes_fk_account ON card_scopes(id, card_account_id);

-- index idx_card_scopes_fk_kind on card_scopes
CREATE UNIQUE INDEX idx_card_scopes_fk_kind ON card_scopes(id, card_account_id, kind);

-- index idx_card_scopes_one_legacy on card_scopes
CREATE UNIQUE INDEX idx_card_scopes_one_legacy ON card_scopes(card_account_id) WHERE kind = 'legacy';

-- index idx_card_scopes_one_unknown on card_scopes
CREATE UNIQUE INDEX idx_card_scopes_one_unknown ON card_scopes(card_account_id) WHERE kind = 'unknown';

-- index idx_card_source_binding_scopes_active on card_source_binding_scopes
CREATE UNIQUE INDEX idx_card_source_binding_scopes_active ON card_source_binding_scopes(binding_id, card_scope_id) WHERE status = 'active';

-- index idx_card_source_binding_scopes_binding on card_source_binding_scopes
CREATE INDEX idx_card_source_binding_scopes_binding ON card_source_binding_scopes(binding_id, status);

-- index idx_card_source_binding_scopes_scope on card_source_binding_scopes
CREATE INDEX idx_card_source_binding_scopes_scope ON card_source_binding_scopes(card_scope_id);

-- index idx_card_source_bindings_account on card_source_bindings
CREATE INDEX idx_card_source_bindings_account ON card_source_bindings(card_account_id, status);

-- index idx_card_source_bindings_digest on card_source_bindings
CREATE UNIQUE INDEX idx_card_source_bindings_digest ON card_source_bindings(source, source_account_digest)
  WHERE source_account_digest IS NOT NULL AND status <> 'retired';

-- index idx_card_source_bindings_fk_account on card_source_bindings
CREATE UNIQUE INDEX idx_card_source_bindings_fk_account ON card_source_bindings(id, card_account_id);

-- index idx_card_source_bindings_fk_source on card_source_bindings
CREATE UNIQUE INDEX idx_card_source_bindings_fk_source ON card_source_bindings(id, card_account_id, source);

-- index idx_card_source_bindings_live on card_source_bindings
CREATE UNIQUE INDEX idx_card_source_bindings_live ON card_source_bindings(card_account_id, source) WHERE status <> 'retired';

-- index idx_card_source_identities_canonical on card_source_identities
CREATE INDEX idx_card_source_identities_canonical ON card_source_identities(canonical_transaction_id, status);

-- index idx_card_source_identities_first_observation on card_source_identities
CREATE INDEX idx_card_source_identities_first_observation ON card_source_identities(first_observation_id);

-- index idx_card_source_identities_last_seen_run on card_source_identities
CREATE INDEX idx_card_source_identities_last_seen_run ON card_source_identities(last_seen_run_id);

-- index idx_card_source_identities_page on card_source_identities
CREATE INDEX idx_card_source_identities_page ON card_source_identities(canonical_transaction_id, created_at, id);

-- index idx_card_source_identities_tuple on card_source_identities
CREATE UNIQUE INDEX idx_card_source_identities_tuple
  ON card_source_identities(card_account_id, source_scope_id, namespace, id_hash);

-- index idx_card_source_observations_file_open on card_source_observations
CREATE UNIQUE INDEX idx_card_source_observations_file_open
  ON card_source_observations(card_account_id, source_scope_id, identity_namespace, identity_hash, content_digest)
  WHERE origin = 'file' AND state = 'open';

-- index idx_card_source_observations_identity on card_source_observations
CREATE INDEX idx_card_source_observations_identity
  ON card_source_observations(card_account_id, source_scope_id, identity_namespace, identity_hash);

-- index idx_card_source_observations_ordinal on card_source_observations
CREATE UNIQUE INDEX idx_card_source_observations_ordinal ON card_source_observations(observation_set_id, ordinal);

-- index idx_card_source_observations_set_state on card_source_observations
CREATE INDEX idx_card_source_observations_set_state ON card_source_observations(observation_set_id, state);

-- index idx_card_source_observations_txn on card_source_observations
CREATE INDEX idx_card_source_observations_txn ON card_source_observations(resolved_transaction_id);

-- index idx_card_sync_audit_events_created on card_sync_audit_events
CREATE INDEX idx_card_sync_audit_events_created ON card_sync_audit_events(created_at);

-- index idx_card_sync_audit_events_device on card_sync_audit_events
CREATE INDEX idx_card_sync_audit_events_device ON card_sync_audit_events(device_id, created_at);

-- index idx_card_sync_audit_events_set on card_sync_audit_events
CREATE INDEX idx_card_sync_audit_events_set ON card_sync_audit_events(observation_set_id);

-- index idx_card_sync_audit_events_type on card_sync_audit_events
CREATE INDEX idx_card_sync_audit_events_type ON card_sync_audit_events(event_type, code, created_at);

-- index idx_card_sync_commit_plans_device on card_sync_commit_plans
CREATE INDEX idx_card_sync_commit_plans_device ON card_sync_commit_plans(device_id, status);

-- index idx_card_sync_commit_plans_fk_kind on card_sync_commit_plans
CREATE UNIQUE INDEX idx_card_sync_commit_plans_fk_kind ON card_sync_commit_plans(id, card_account_id, plan_kind);

-- index idx_card_sync_commit_plans_one_prepared on card_sync_commit_plans
CREATE UNIQUE INDEX idx_card_sync_commit_plans_one_prepared ON card_sync_commit_plans(observation_set_id) WHERE status = 'prepared';

-- index idx_card_sync_commit_plans_set on card_sync_commit_plans
CREATE INDEX idx_card_sync_commit_plans_set ON card_sync_commit_plans(observation_set_id, status);

-- index idx_card_sync_commit_plans_status on card_sync_commit_plans
CREATE INDEX idx_card_sync_commit_plans_status ON card_sync_commit_plans(status, expires_at);

-- index idx_card_sync_device_scopes_active on card_sync_device_scopes
CREATE UNIQUE INDEX idx_card_sync_device_scopes_active ON card_sync_device_scopes(device_id, binding_id) WHERE status = 'active';

-- index idx_card_sync_device_scopes_binding on card_sync_device_scopes
CREATE INDEX idx_card_sync_device_scopes_binding ON card_sync_device_scopes(binding_id, status);

-- index idx_card_sync_device_scopes_device on card_sync_device_scopes
CREATE INDEX idx_card_sync_device_scopes_device ON card_sync_device_scopes(device_id, status);

-- index idx_card_sync_devices_pairing on card_sync_devices
CREATE UNIQUE INDEX idx_card_sync_devices_pairing ON card_sync_devices(pairing_id);

-- index idx_card_sync_devices_status on card_sync_devices
CREATE INDEX idx_card_sync_devices_status ON card_sync_devices(status, expires_at);

-- index idx_card_sync_devices_token on card_sync_devices
CREATE UNIQUE INDEX idx_card_sync_devices_token ON card_sync_devices(token_digest) WHERE token_digest IS NOT NULL;

-- index idx_card_sync_namespaces_fk_kind on card_sync_namespaces
CREATE UNIQUE INDEX idx_card_sync_namespaces_fk_kind ON card_sync_namespaces(namespace, kind);

-- index idx_card_sync_namespaces_one_capture on card_sync_namespaces
CREATE UNIQUE INDEX idx_card_sync_namespaces_one_capture ON card_sync_namespaces(source) WHERE kind = 'capture';

-- index idx_card_sync_namespaces_source on card_sync_namespaces
CREATE INDEX idx_card_sync_namespaces_source ON card_sync_namespaces(source);

-- index idx_card_sync_observation_sets_account on card_sync_observation_sets
CREATE INDEX idx_card_sync_observation_sets_account ON card_sync_observation_sets(card_account_id, state);

-- index idx_card_sync_observation_sets_batch_chunk on card_sync_observation_sets
CREATE UNIQUE INDEX idx_card_sync_observation_sets_batch_chunk ON card_sync_observation_sets(import_batch_id, file_chunk);

-- index idx_card_sync_observation_sets_binding on card_sync_observation_sets
CREATE INDEX idx_card_sync_observation_sets_binding ON card_sync_observation_sets(binding_id, state);

-- index idx_card_sync_observation_sets_capture on card_sync_observation_sets
CREATE UNIQUE INDEX idx_card_sync_observation_sets_capture ON card_sync_observation_sets(capture_id);

-- index idx_card_sync_observation_sets_device on card_sync_observation_sets
CREATE INDEX idx_card_sync_observation_sets_device ON card_sync_observation_sets(device_id, state);

-- index idx_card_sync_observation_sets_fk_account on card_sync_observation_sets
CREATE UNIQUE INDEX idx_card_sync_observation_sets_fk_account ON card_sync_observation_sets(id, card_account_id);

-- index idx_card_sync_observation_sets_fk_origin on card_sync_observation_sets
CREATE UNIQUE INDEX idx_card_sync_observation_sets_fk_origin ON card_sync_observation_sets(id, origin);

-- index idx_card_sync_observation_sets_run on card_sync_observation_sets
CREATE UNIQUE INDEX idx_card_sync_observation_sets_run ON card_sync_observation_sets(run_id);

-- index idx_card_sync_observation_sets_state on card_sync_observation_sets
CREATE INDEX idx_card_sync_observation_sets_state ON card_sync_observation_sets(state, expires_at);

-- index idx_card_sync_pairing_scopes_binding on card_sync_pairing_scopes
CREATE UNIQUE INDEX idx_card_sync_pairing_scopes_binding ON card_sync_pairing_scopes(pairing_id, binding_id);

-- index idx_card_sync_pairing_scopes_binding_id on card_sync_pairing_scopes
CREATE INDEX idx_card_sync_pairing_scopes_binding_id ON card_sync_pairing_scopes(binding_id);

-- index idx_card_sync_pairings_code on card_sync_pairings
CREATE UNIQUE INDEX idx_card_sync_pairings_code ON card_sync_pairings(code_digest) WHERE code_digest IS NOT NULL;

-- index idx_card_sync_pairings_one_open on card_sync_pairings
CREATE UNIQUE INDEX idx_card_sync_pairings_one_open ON card_sync_pairings(created_by_ref) WHERE status = 'open';

-- index idx_card_sync_pairings_replaces on card_sync_pairings
CREATE INDEX idx_card_sync_pairings_replaces ON card_sync_pairings(replaces_device_id);

-- index idx_card_sync_pairings_status on card_sync_pairings
CREATE INDEX idx_card_sync_pairings_status ON card_sync_pairings(status, expires_at);

-- index idx_card_sync_payload_receipts_expiry on card_sync_payload_receipts
CREATE INDEX idx_card_sync_payload_receipts_expiry ON card_sync_payload_receipts(expires_at);

-- index idx_card_sync_runs_binding on card_sync_runs
CREATE INDEX idx_card_sync_runs_binding ON card_sync_runs(binding_id, created_at);

-- index idx_card_sync_runs_client on card_sync_runs
CREATE UNIQUE INDEX idx_card_sync_runs_client ON card_sync_runs(device_id, client_run_id);

-- index idx_card_sync_runs_device_created on card_sync_runs
CREATE INDEX idx_card_sync_runs_device_created ON card_sync_runs(device_id, created_at);

-- index idx_card_sync_runs_fk_account on card_sync_runs
CREATE UNIQUE INDEX idx_card_sync_runs_fk_account ON card_sync_runs(id, card_account_id);

-- index idx_card_sync_runs_open on card_sync_runs
CREATE INDEX idx_card_sync_runs_open ON card_sync_runs(upload_expires_at) WHERE acceptance_state = 'open';

-- index idx_card_sync_set_card_hints_last4 on card_sync_set_card_hints
CREATE UNIQUE INDEX idx_card_sync_set_card_hints_last4 ON card_sync_set_card_hints(observation_set_id, last4);

-- index idx_card_sync_sources_fk_issuer on card_sync_sources
CREATE UNIQUE INDEX idx_card_sync_sources_fk_issuer ON card_sync_sources(source, issuer);

-- index idx_card_sync_sources_fk_mode on card_sync_sources
CREATE UNIQUE INDEX idx_card_sync_sources_fk_mode ON card_sync_sources(source, issuer, mode);

-- index idx_card_transaction_events_account on card_transaction_events
CREATE INDEX idx_card_transaction_events_account ON card_transaction_events(card_account_id, created_at);

-- index idx_card_transaction_events_cause on card_transaction_events
CREATE INDEX idx_card_transaction_events_cause ON card_transaction_events(cause_event_id);

-- index idx_card_transaction_events_history on card_transaction_events
CREATE INDEX idx_card_transaction_events_history ON card_transaction_events(card_transaction_id, created_at, id);

-- index idx_card_transaction_events_identity on card_transaction_events
CREATE INDEX idx_card_transaction_events_identity ON card_transaction_events(identity_id);

-- index idx_card_transaction_events_moved_away on card_transaction_events
CREATE INDEX idx_card_transaction_events_moved_away ON card_transaction_events(from_canonical_id, created_at, id)
  WHERE event_type = 'identity-repointed';

-- index idx_card_transaction_events_observation on card_transaction_events
CREATE INDEX idx_card_transaction_events_observation ON card_transaction_events(observation_id);

-- index idx_card_transaction_events_reverses on card_transaction_events
CREATE INDEX idx_card_transaction_events_reverses ON card_transaction_events(reverses_event_id);

-- index idx_card_transaction_events_run on card_transaction_events
CREATE INDEX idx_card_transaction_events_run ON card_transaction_events(run_id);

-- index idx_card_transaction_events_set on card_transaction_events
CREATE INDEX idx_card_transaction_events_set ON card_transaction_events(observation_set_id);

-- index idx_card_transaction_events_txn on card_transaction_events
CREATE INDEX idx_card_transaction_events_txn ON card_transaction_events(card_transaction_id, transaction_revision);

-- index idx_card_transactions_account_date on card_transactions
CREATE INDEX idx_card_transactions_account_date ON card_transactions(card_account_id, transaction_date);

-- index idx_card_transactions_amount on card_transactions
CREATE INDEX idx_card_transactions_amount ON card_transactions(card_account_id, currency, amount_minor, transaction_date);

-- index idx_card_transactions_batch on card_transactions
CREATE INDEX idx_card_transactions_batch ON card_transactions(import_batch_id);

-- index idx_card_transactions_fk_account on card_transactions
CREATE UNIQUE INDEX idx_card_transactions_fk_account ON card_transactions(id, card_account_id);

-- index idx_card_transactions_merged on card_transactions
CREATE INDEX idx_card_transactions_merged ON card_transactions(merged_into_id, removed_at, id);

-- index idx_card_transactions_run on card_transactions
CREATE INDEX idx_card_transactions_run ON card_transactions(first_sync_run_id);

-- index idx_card_transactions_scope on card_transactions
CREATE INDEX idx_card_transactions_scope ON card_transactions(card_scope_id);

-- index sqlite_autoindex_card_accounts_1 on card_accounts
-- (created by SQLite)

-- index sqlite_autoindex_card_coverage_windows_1 on card_coverage_windows
-- (created by SQLite)

-- index sqlite_autoindex_card_identity_contents_1 on card_identity_contents
-- (created by SQLite)

-- index sqlite_autoindex_card_import_batches_1 on card_import_batches
-- (created by SQLite)

-- index sqlite_autoindex_card_observation_secondary_ids_1 on card_observation_secondary_ids
-- (created by SQLite)

-- index sqlite_autoindex_card_payment_links_1 on card_payment_links
-- (created by SQLite)

-- index sqlite_autoindex_card_reconciliation_candidates_1 on card_reconciliation_candidates
-- (created by SQLite)

-- index sqlite_autoindex_card_reconciliation_suggestions_1 on card_reconciliation_suggestions
-- (created by SQLite)

-- index sqlite_autoindex_card_scopes_1 on card_scopes
-- (created by SQLite)

-- index sqlite_autoindex_card_source_binding_scopes_1 on card_source_binding_scopes
-- (created by SQLite)

-- index sqlite_autoindex_card_source_bindings_1 on card_source_bindings
-- (created by SQLite)

-- index sqlite_autoindex_card_source_identities_1 on card_source_identities
-- (created by SQLite)

-- index sqlite_autoindex_card_source_observations_1 on card_source_observations
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_audit_events_1 on card_sync_audit_events
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_commit_plans_1 on card_sync_commit_plans
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_device_scopes_1 on card_sync_device_scopes
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_devices_1 on card_sync_devices
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_issuer_policy_1 on card_sync_issuer_policy
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_namespaces_1 on card_sync_namespaces
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_observation_sets_1 on card_sync_observation_sets
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_pairing_scopes_1 on card_sync_pairing_scopes
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_pairings_1 on card_sync_pairings
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_payload_receipts_1 on card_sync_payload_receipts
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_plan_actions_1 on card_sync_plan_actions
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_policy_1 on card_sync_policy
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_runs_1 on card_sync_runs
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_set_card_hints_1 on card_sync_set_card_hints
-- (created by SQLite)

-- index sqlite_autoindex_card_sync_sources_1 on card_sync_sources
-- (created by SQLite)

-- index sqlite_autoindex_card_transaction_events_1 on card_transaction_events
-- (created by SQLite)

-- index sqlite_autoindex_card_transaction_versions_1 on card_transaction_versions
-- (created by SQLite)

-- index sqlite_autoindex_card_transactions_1 on card_transactions
-- (created by SQLite)

-- table card_accounts on card_accounts
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
, last5 TEXT CHECK (last5 IS NULL OR (
  typeof(last5) = 'text' AND length(CAST(last5 AS BLOB)) = 5 AND last5 GLOB '[0-9][0-9][0-9][0-9][0-9]'
  AND last4 IS NOT NULL AND substr(last5, 2) = last4)), ledger_revision INTEGER NOT NULL DEFAULT 0
  CONSTRAINT ck_acct_ledger_revision CHECK (ledger_revision = CAST(ledger_revision AS INTEGER) AND ledger_revision BETWEEN 0 AND 2147483647));

-- table card_coverage_windows on card_coverage_windows
CREATE TABLE card_coverage_windows (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_cov_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-cover-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL,
  card_scope_id               TEXT NOT NULL,
  source_kind                 TEXT NOT NULL CONSTRAINT ck_cov_source_kind CHECK (source_kind IN ('file', 'extension')),
  source                      TEXT NOT NULL CONSTRAINT ck_cov_source CHECK (typeof(source) = 'text' AND length(CAST(source AS BLOB)) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9-]*'),
  import_batch_id             TEXT,
  observation_set_id          TEXT,
  entry_ordinal               INTEGER CONSTRAINT ck_cov_entry_ordinal CHECK (entry_ordinal IS NULL OR (entry_ordinal = CAST(entry_ordinal AS INTEGER) AND entry_ordinal BETWEEN 0 AND 39)),
  status                      TEXT NOT NULL CONSTRAINT ck_cov_status CHECK (status IN ('pending', 'posted', 'any')),
  requested_start             TEXT CONSTRAINT ck_cov_requested_start CHECK (requested_start IS NULL OR (typeof(requested_start) = 'text' AND length(CAST(requested_start AS BLOB)) = 10 AND date(requested_start) IS requested_start)),
  requested_end               TEXT CONSTRAINT ck_cov_requested_end CHECK (requested_end IS NULL OR (typeof(requested_end) = 'text' AND length(CAST(requested_end AS BLOB)) = 10 AND date(requested_end) IS requested_end)),
  requested_basis             TEXT CONSTRAINT ck_cov_requested_basis CHECK (requested_basis IS NULL OR (requested_basis IN ('transaction', 'posted', 'observation', 'posted-or-transaction'))),
  observed_start              TEXT CONSTRAINT ck_cov_observed_start CHECK (observed_start IS NULL OR (typeof(observed_start) = 'text' AND length(CAST(observed_start AS BLOB)) = 10 AND date(observed_start) IS observed_start)),
  observed_end                TEXT CONSTRAINT ck_cov_observed_end CHECK (observed_end IS NULL OR (typeof(observed_end) = 'text' AND length(CAST(observed_end AS BLOB)) = 10 AND date(observed_end) IS observed_end)),
  observed_basis              TEXT CONSTRAINT ck_cov_observed_basis CHECK (observed_basis IS NULL OR (observed_basis IN ('transaction', 'posted', 'observation', 'posted-or-transaction'))),
  claimed_completeness        TEXT NOT NULL CONSTRAINT ck_cov_claimed_completeness CHECK (claimed_completeness IN ('unknown', 'partial', 'complete')),
  verified_completeness       TEXT NOT NULL CONSTRAINT ck_cov_verified_completeness CHECK (verified_completeness IN ('unknown', 'partial', 'complete')),
  termination                 TEXT CONSTRAINT ck_cov_termination CHECK (termination IS NULL OR (termination IN ('end-marker', 'snapshot', 'more-available', 'user-navigation', 'cap', 'repeated-cursor', 'empty-page', 'rate-limited', 'auth-required', 'error', 'not-read'))),
  page_count                  INTEGER CONSTRAINT ck_cov_page_count CHECK (page_count IS NULL OR (page_count = CAST(page_count AS INTEGER) AND page_count BETWEEN 0 AND 100)),
  evidence                    TEXT NOT NULL CONSTRAINT ck_cov_evidence CHECK (evidence IN ('file-declared', 'extension-claimed', 'statement-reconciled')),
  ledger_state                TEXT NOT NULL CONSTRAINT ck_cov_ledger_state CHECK (ledger_state IN ('observed-uncommitted', 'committed', 'expired-unreviewed', 'rejected')),
  observed_at                 TEXT CONSTRAINT ck_cov_observed_at CHECK (observed_at IS NULL OR (typeof(observed_at) = 'text' AND length(CAST(observed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at)),
  recorded_at                 TEXT NOT NULL CONSTRAINT ck_cov_recorded_at CHECK (typeof(recorded_at) = 'text' AND length(CAST(recorded_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_cov_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (card_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, card_account_id) REFERENCES card_import_batches(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_cov_origin CHECK (((source_kind = 'file') = (import_batch_id IS NOT NULL) AND (source_kind = 'extension') = (observation_set_id IS NOT NULL) AND (source_kind = 'extension') = (entry_ordinal IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_cov_file_shape CHECK ((source_kind = 'extension' OR (status = 'any' AND coalesce(requested_basis, 'posted-or-transaction') = 'posted-or-transaction' AND coalesce(observed_basis, 'posted-or-transaction') = 'posted-or-transaction' AND termination IS NULL AND page_count IS NULL AND evidence = 'file-declared' AND observed_at IS NULL AND ledger_state = 'committed' AND claimed_completeness = 'unknown' AND verified_completeness = 'unknown')) IS TRUE),
  CONSTRAINT ck_cov_extension_shape CHECK ((source_kind = 'file' OR (status IN ('pending', 'posted') AND requested_basis IS NOT 'posted-or-transaction' AND observed_basis IS NOT 'posted-or-transaction' AND termination IS NOT NULL AND page_count IS NOT NULL AND evidence IN ('extension-claimed', 'statement-reconciled') AND observed_at IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_cov_requested_shape CHECK (((requested_start IS NULL) = (requested_end IS NULL) AND (requested_start IS NULL) = (requested_basis IS NULL) AND (requested_end IS NULL OR requested_end >= requested_start)) IS TRUE),
  CONSTRAINT ck_cov_observed_shape CHECK (((observed_start IS NULL) = (observed_end IS NULL) AND (observed_start IS NULL) = (observed_basis IS NULL) AND (observed_end IS NULL OR observed_end >= observed_start)) IS TRUE),
  CONSTRAINT ck_cov_completeness CHECK (((CASE verified_completeness WHEN 'unknown' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END) <= (CASE claimed_completeness WHEN 'unknown' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END) AND (claimed_completeness <> 'complete' OR (termination = 'end-marker' AND requested_start IS NOT NULL))) IS TRUE),
  CONSTRAINT ck_cov_observation_basis CHECK ((((requested_basis IS NOT 'observation' AND observed_basis IS NOT 'observation') OR status = 'pending') AND (observed_basis IS NOT 'observation' OR observed_start = observed_end)) IS TRUE),
  CONSTRAINT ck_cov_not_read CHECK ((termination IS NOT 'not-read' OR (page_count = 0 AND observed_start IS NULL)) IS TRUE)
);

-- table card_identity_contents on card_identity_contents
CREATE TABLE card_identity_contents (
  identity_id                 TEXT NOT NULL REFERENCES card_source_identities(id) ON DELETE RESTRICT,
  content_digest              TEXT NOT NULL CONSTRAINT ck_icont_content_digest CHECK (typeof(content_digest) = 'text' AND length(CAST(content_digest AS BLOB)) = 69 AND substr(content_digest, 1, 5) = 'rcd1:' AND substr(content_digest, 6) NOT GLOB '*[^a-p]*'),
  resolution                  TEXT NOT NULL CONSTRAINT ck_icont_resolution CHECK (resolution IN ('migration-baseline', 'inserted', 'promoted', 'corrected', 'linked', 'matched-current', 'kept-current')),
  recorded_at                 TEXT NOT NULL CONSTRAINT ck_icont_recorded_at CHECK (typeof(recorded_at) = 'text' AND length(CAST(recorded_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at),
  CONSTRAINT pk_card_identity_contents PRIMARY KEY (identity_id, content_digest)
);

-- table card_import_batches on card_import_batches
CREATE TABLE card_import_batches (
  id               TEXT PRIMARY KEY,
  card_account_id  TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  source           TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  parser_version   TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  row_count        INTEGER NOT NULL CHECK (row_count = CAST(row_count AS INTEGER) AND row_count >= 0),
  new_count        INTEGER NOT NULL CHECK (new_count = CAST(new_count AS INTEGER) AND new_count >= 0),
  duplicate_count  INTEGER NOT NULL CHECK (duplicate_count = CAST(duplicate_count AS INTEGER) AND duplicate_count >= 0),
  rejected_count   INTEGER NOT NULL CHECK (rejected_count = CAST(rejected_count AS INTEGER) AND rejected_count >= 0),
  imported_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), coverage_start TEXT CHECK (coverage_start IS NULL OR (
  typeof(coverage_start) = 'text' AND length(CAST(coverage_start AS BLOB)) = 10
  AND coverage_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')), coverage_end TEXT CHECK ((coverage_end IS NULL AND coverage_start IS NULL) OR (
  coverage_start IS NOT NULL AND typeof(coverage_end) = 'text' AND length(CAST(coverage_end AS BLOB)) = 10
  AND coverage_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND coverage_end >= coverage_start)),
  CHECK (new_count + duplicate_count + rejected_count = row_count)
);

-- table card_observation_secondary_ids on card_observation_secondary_ids
CREATE TABLE card_observation_secondary_ids (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_sid_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-obsid-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  observation_id              TEXT NOT NULL REFERENCES card_source_observations(id) ON DELETE CASCADE,
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_sid_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 1 AND 3),
  namespace                   TEXT NOT NULL,
  namespace_kind              TEXT NOT NULL CONSTRAINT ck_sid_namespace_kind CHECK (namespace_kind = 'stable'),
  id_hash                     TEXT NOT NULL CONSTRAINT ck_sid_id_hash CHECK (typeof(id_hash) = 'text' AND length(CAST(id_hash AS BLOB)) = 69 AND substr(id_hash, 1, 5) = 'xid1:' AND substr(id_hash, 6) NOT GLOB '*[^a-p]*'),
  FOREIGN KEY (namespace, namespace_kind) REFERENCES card_sync_namespaces(namespace, kind) ON DELETE RESTRICT
);

-- table card_payment_links on card_payment_links
CREATE TABLE card_payment_links (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_link_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 42 AND substr(id, 1, 10) = 'card-link-' AND substr(id, 11) NOT GLOB '*[^a-p]*'),
  card_transaction_id         TEXT NOT NULL REFERENCES card_transactions(id) ON DELETE RESTRICT,
  cash_event_ref              TEXT NOT NULL CONSTRAINT ck_link_cash_event_ref CHECK (typeof(cash_event_ref) = 'text' AND length(CAST(cash_event_ref AS BLOB)) = 69 AND substr(cash_event_ref, 1, 5) = 'cer1:' AND substr(cash_event_ref, 6) NOT GLOB '*[^a-p]*'),
  decision                    TEXT NOT NULL CONSTRAINT ck_link_decision CHECK (decision IN ('confirmed', 'rejected')),
  amount_minor                INTEGER NOT NULL CONSTRAINT ck_link_amount_minor CHECK (amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND -1),
  currency                    TEXT NOT NULL CONSTRAINT ck_link_currency CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  rules_version               INTEGER NOT NULL CONSTRAINT ck_link_rules_version CHECK (rules_version = CAST(rules_version AS INTEGER) AND rules_version BETWEEN 1 AND 999),
  decided_at                  TEXT NOT NULL CONSTRAINT ck_link_decided_at CHECK (typeof(decided_at) = 'text' AND length(CAST(decided_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS decided_at),
  decided_by_ref              TEXT CONSTRAINT ck_link_decided_by_ref CHECK (decided_by_ref IS NULL OR (typeof(decided_by_ref) = 'text' AND length(CAST(decided_by_ref AS BLOB)) = 36 AND substr(decided_by_ref, 1, 4) = 'usr_' AND substr(decided_by_ref, 5) NOT GLOB '*[^a-p]*'))
);

-- table card_reconciliation_candidates on card_reconciliation_candidates
CREATE TABLE card_reconciliation_candidates (
  review_item_id              TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  rank                        INTEGER NOT NULL CONSTRAINT ck_cand_rank CHECK (rank = CAST(rank AS INTEGER) AND rank BETWEEN 1 AND 5),
  transaction_id              TEXT NOT NULL,
  rule                        TEXT NOT NULL CONSTRAINT ck_cand_rule CHECK (rule IN ('identity:v1', 'near-content:v1', 'exact-content:v1')),
  matched_on                  INTEGER NOT NULL CONSTRAINT ck_cand_matched_on CHECK (matched_on = CAST(matched_on AS INTEGER) AND matched_on BETWEEN 0 AND 31),
  blocked_reason              TEXT CONSTRAINT ck_cand_blocked_reason CHECK (blocked_reason IS NULL OR (blocked_reason IN ('different-known-cards'))),
  CONSTRAINT pk_card_reconciliation_candidates PRIMARY KEY (review_item_id, rank),
  FOREIGN KEY (review_item_id, card_account_id) REFERENCES card_reconciliation_suggestions(id, card_account_id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_cand_blocked CHECK ((blocked_reason IS NULL OR rule = 'near-content:v1') IS TRUE)
);

-- table card_reconciliation_suggestions on card_reconciliation_suggestions
CREATE TABLE card_reconciliation_suggestions (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_rvw_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'rvw_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  observation_set_id          TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  observation_id              TEXT REFERENCES card_source_observations(id) ON DELETE CASCADE,
  category                    TEXT NOT NULL CONSTRAINT ck_rvw_category CHECK (category IN ('cross-source-similar', 'no-stable-id', 'scope-unknown', 'pending-link', 'posted-correction', 'reconciliation-difference')),
  reason                      TEXT NOT NULL CONSTRAINT ck_rvw_reason CHECK (reason IN ('cross-source-similar', 'identity-conflict', 'detached-identity', 'no-stable-id', 'unknown-scope', 'pending-posted', 'pending-may-have-posted', 'removed-hit', 'posted-correction', 'pending-changed', 'statement-mismatch')),
  allowed_actions             INTEGER NOT NULL CONSTRAINT ck_rvw_allowed_actions CHECK (allowed_actions = CAST(allowed_actions AS INTEGER) AND allowed_actions BETWEEN 1 AND 255),
  difference_field            TEXT CONSTRAINT ck_rvw_difference_field CHECK (difference_field IS NULL OR (difference_field IN ('charges', 'credits', 'net', 'new-balance'))),
  expected_minor              INTEGER CONSTRAINT ck_rvw_expected_minor CHECK (expected_minor IS NULL OR (expected_minor = CAST(expected_minor AS INTEGER) AND expected_minor BETWEEN -999999999999 AND 999999999999)),
  actual_minor                INTEGER CONSTRAINT ck_rvw_actual_minor CHECK (actual_minor IS NULL OR (actual_minor = CAST(actual_minor AS INTEGER) AND actual_minor BETWEEN -999999999999 AND 999999999999)),
  status                      TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_rvw_status CHECK (status IN ('open', 'decided', 'committed', 'superseded', 'expired', 'discarded')),
  draft_action                TEXT CONSTRAINT ck_rvw_draft_action CHECK (draft_action IS NULL OR (draft_action IN ('same-transaction', 'attribute-and-link', 'attribute', 'insert-new', 'accept-correction', 'keep-current', 'accept-difference', 'reject-row'))),
  draft_transaction_id        TEXT,
  draft_scope_id              TEXT,
  drafted_by_ref              TEXT CONSTRAINT ck_rvw_drafted_by_ref CHECK (drafted_by_ref IS NULL OR (typeof(drafted_by_ref) = 'text' AND length(CAST(drafted_by_ref AS BLOB)) = 36 AND substr(drafted_by_ref, 1, 4) = 'usr_' AND substr(drafted_by_ref, 5) NOT GLOB '*[^a-p]*')),
  drafted_at                  TEXT CONSTRAINT ck_rvw_drafted_at CHECK (drafted_at IS NULL OR (typeof(drafted_at) = 'text' AND length(CAST(drafted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', drafted_at) IS drafted_at)),
  committed_action            TEXT CONSTRAINT ck_rvw_committed_action CHECK (committed_action IS NULL OR (committed_action IN ('same-transaction', 'attribute-and-link', 'attribute', 'insert-new', 'accept-correction', 'keep-current', 'accept-difference', 'reject-row'))),
  committed_transaction_id    TEXT,
  committed_scope_id          TEXT,
  committed_revision          INTEGER CONSTRAINT ck_rvw_committed_revision CHECK (committed_revision IS NULL OR (committed_revision = CAST(committed_revision AS INTEGER) AND committed_revision BETWEEN 1 AND 2147483647)),
  committed_plan_id           TEXT CONSTRAINT ck_rvw_committed_plan_id CHECK (committed_plan_id IS NULL OR (typeof(committed_plan_id) = 'text' AND length(CAST(committed_plan_id AS BLOB)) = 36 AND substr(committed_plan_id, 1, 4) = 'prv_' AND substr(committed_plan_id, 5) NOT GLOB '*[^a-p]*')),
  committed_at                TEXT CONSTRAINT ck_rvw_committed_at CHECK (committed_at IS NULL OR (typeof(committed_at) = 'text' AND length(CAST(committed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', committed_at) IS committed_at)),
  classified_ledger_revision  INTEGER NOT NULL CONSTRAINT ck_rvw_classified_ledger_revision CHECK (classified_ledger_revision = CAST(classified_ledger_revision AS INTEGER) AND classified_ledger_revision BETWEEN 0 AND 2147483647),
  created_at                  TEXT NOT NULL CONSTRAINT ck_rvw_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_rvw_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (id, draft_transaction_id) REFERENCES card_reconciliation_candidates(review_item_id, transaction_id) ON DELETE RESTRICT,
  FOREIGN KEY (committed_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (draft_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (committed_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_rvw_level CHECK (((observation_id IS NULL) = (category = 'reconciliation-difference') AND (observation_id IS NULL) = (difference_field IS NOT NULL) AND (difference_field IS NULL) = (expected_minor IS NULL) AND (difference_field IS NULL) = (actual_minor IS NULL) AND (difference_field IS NULL OR expected_minor <> actual_minor)) IS TRUE),
  CONSTRAINT ck_rvw_reason_category CHECK (((reason = 'cross-source-similar' AND category = 'cross-source-similar') OR (reason = 'identity-conflict' AND category = 'cross-source-similar') OR (reason = 'detached-identity' AND category = 'cross-source-similar') OR (reason = 'no-stable-id' AND category = 'no-stable-id') OR (reason = 'unknown-scope' AND category = 'scope-unknown') OR (reason = 'pending-posted' AND category = 'pending-link') OR (reason = 'pending-may-have-posted' AND category = 'pending-link') OR (reason = 'removed-hit' AND category = 'pending-link') OR (reason = 'posted-correction' AND category = 'posted-correction') OR (reason = 'pending-changed' AND category = 'posted-correction') OR (reason = 'removed-hit' AND category = 'posted-correction') OR (reason = 'statement-mismatch' AND category = 'reconciliation-difference')) IS TRUE),
  CONSTRAINT ck_rvw_actions_in_category CHECK (((allowed_actions & ~(CASE category WHEN 'cross-source-similar' THEN 139 WHEN 'no-stable-id' THEN 137 WHEN 'scope-unknown' THEN 141 WHEN 'pending-link' THEN 137 WHEN 'posted-correction' THEN 48 WHEN 'reconciliation-difference' THEN 64 END)) = 0) IS TRUE),
  CONSTRAINT ck_rvw_draft_shape CHECK (((draft_action IS NULL) = (drafted_at IS NULL) AND (drafted_at IS NULL) = (drafted_by_ref IS NULL) AND (draft_action IS NULL OR (allowed_actions & (CASE draft_action WHEN 'same-transaction' THEN 1 WHEN 'attribute-and-link' THEN 2 WHEN 'attribute' THEN 4 WHEN 'insert-new' THEN 8 WHEN 'accept-correction' THEN 16 WHEN 'keep-current' THEN 32 WHEN 'accept-difference' THEN 64 WHEN 'reject-row' THEN 128 END)) <> 0) AND coalesce(draft_action IN ('same-transaction', 'attribute-and-link'), 0) = (draft_transaction_id IS NOT NULL) AND coalesce(draft_action = 'attribute', 0) <= (draft_scope_id IS NOT NULL) AND (draft_scope_id IS NULL OR draft_action IN ('attribute', 'attribute-and-link'))) IS TRUE),
  CONSTRAINT ck_rvw_committed_shape CHECK (((committed_action IS NULL) = (committed_at IS NULL) AND (committed_action IS NULL) = (committed_plan_id IS NULL) AND (committed_action IS NULL OR (allowed_actions & (CASE committed_action WHEN 'same-transaction' THEN 1 WHEN 'attribute-and-link' THEN 2 WHEN 'attribute' THEN 4 WHEN 'insert-new' THEN 8 WHEN 'accept-correction' THEN 16 WHEN 'keep-current' THEN 32 WHEN 'accept-difference' THEN 64 WHEN 'reject-row' THEN 128 END)) <> 0) AND (committed_action IS NULL OR committed_action IN ('reject-row', 'accept-difference')) = (committed_transaction_id IS NULL) AND (committed_transaction_id IS NULL) = (committed_revision IS NULL) AND (committed_scope_id IS NULL OR committed_action IN ('attribute', 'attribute-and-link')) AND coalesce(committed_action = 'attribute', 0) <= (committed_scope_id IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_rvw_status_shape CHECK (((status <> 'open' OR (draft_action IS NULL AND committed_action IS NULL)) AND (status = 'decided') = (draft_action IS NOT NULL) AND (status <> 'committed' OR committed_action IS NOT NULL) AND (committed_action IS NULL OR status IN ('committed', 'decided'))) IS TRUE)
);

-- table card_scopes on card_scopes
CREATE TABLE card_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_scope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'scp_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL REFERENCES card_accounts(id) ON DELETE RESTRICT,
  kind                        TEXT NOT NULL CONSTRAINT ck_scope_kind CHECK (kind IN ('known', 'unknown', 'legacy')),
  holder_alias                TEXT NOT NULL CONSTRAINT ck_scope_holder_alias CHECK (holder_alias IN ('alex', 'casey', 'joint', 'member-a', 'unknown')),
  last4                       TEXT CONSTRAINT ck_scope_last4 CHECK (last4 IS NULL OR (typeof(last4) = 'text' AND length(CAST(last4 AS BLOB)) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]')),
  label                       TEXT NOT NULL CONSTRAINT ck_scope_label CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 64),
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_scope_status CHECK (status IN ('active', 'retired')),
  version                     INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_scope_version CHECK (version = CAST(version AS INTEGER) AND version BETWEEN 1 AND 2147483647),
  confirmed_by_ref            TEXT CONSTRAINT ck_scope_confirmed_by_ref CHECK (confirmed_by_ref IS NULL OR (typeof(confirmed_by_ref) = 'text' AND length(CAST(confirmed_by_ref AS BLOB)) = 36 AND substr(confirmed_by_ref, 1, 4) = 'usr_' AND substr(confirmed_by_ref, 5) NOT GLOB '*[^a-p]*')),
  confirmed_at                TEXT CONSTRAINT ck_scope_confirmed_at CHECK (confirmed_at IS NULL OR (typeof(confirmed_at) = 'text' AND length(CAST(confirmed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS confirmed_at)),
  retired_at                  TEXT CONSTRAINT ck_scope_retired_at CHECK (retired_at IS NULL OR (typeof(retired_at) = 'text' AND length(CAST(retired_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) IS retired_at)),
  created_at                  TEXT NOT NULL CONSTRAINT ck_scope_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_scope_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CONSTRAINT ck_scope_alias_kind CHECK (((kind = 'known') = (holder_alias <> 'unknown')) IS TRUE),
  CONSTRAINT ck_scope_unresolved_shape CHECK ((kind = 'known' OR (last4 IS NULL AND status = 'active')) IS TRUE),
  CONSTRAINT ck_scope_confirmation CHECK (((confirmed_by_ref IS NULL) = (confirmed_at IS NULL) AND (kind = 'legacy') = (confirmed_by_ref IS NULL)) IS TRUE),
  CONSTRAINT ck_scope_retired CHECK (((status = 'retired') = (retired_at IS NOT NULL)) IS TRUE)
);

-- table card_source_binding_scopes on card_source_binding_scopes
CREATE TABLE card_source_binding_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_bscope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-bscope-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  binding_id                  TEXT NOT NULL,
  card_scope_id               TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  card_scope_kind             TEXT NOT NULL CONSTRAINT ck_bscope_card_scope_kind CHECK (card_scope_kind IN ('known', 'unknown')),
  binding_version             INTEGER NOT NULL CONSTRAINT ck_bscope_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_bscope_status CHECK (status IN ('active', 'revoked')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_bscope_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  revoked_at                  TEXT CONSTRAINT ck_bscope_revoked_at CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  CONSTRAINT ck_bscope_revoked CHECK (((status = 'revoked') = (revoked_at IS NOT NULL)) IS TRUE),
  FOREIGN KEY (binding_id, card_account_id) REFERENCES card_source_bindings(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (card_scope_id, card_account_id, card_scope_kind) REFERENCES card_scopes(id, card_account_id, kind) ON DELETE RESTRICT
);

-- table card_source_bindings on card_source_bindings
CREATE TABLE card_source_bindings (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_bind_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'bnd_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL,
  issuer                      TEXT NOT NULL,
  currency                    TEXT NOT NULL,
  source                      TEXT NOT NULL,
  source_account_digest       TEXT CONSTRAINT ck_bind_source_account_digest CHECK (source_account_digest IS NULL OR (typeof(source_account_digest) = 'text' AND length(CAST(source_account_digest AS BLOB)) = 69 AND substr(source_account_digest, 1, 5) = 'sad1:' AND substr(source_account_digest, 6) NOT GLOB '*[^a-p]*')),
  label                       TEXT NOT NULL CONSTRAINT ck_bind_label CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 64),
  status                      TEXT NOT NULL DEFAULT 'confirmed' CONSTRAINT ck_bind_status CHECK (status IN ('confirmed', 'needs-reconfirmation', 'retired')),
  status_reason               TEXT CONSTRAINT ck_bind_status_reason CHECK (status_reason IS NULL OR (status_reason IN ('restored-from-backup', 'card-account-changed', 'contract-changed'))),
  version                     INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_bind_version CHECK (version = CAST(version AS INTEGER) AND version BETWEEN 1 AND 2147483647),
  auto_sync_revision          INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_bind_auto_sync_revision CHECK (auto_sync_revision = CAST(auto_sync_revision AS INTEGER) AND auto_sync_revision BETWEEN 1 AND 2147483647),
  confirmed_by_ref            TEXT NOT NULL CONSTRAINT ck_bind_confirmed_by_ref CHECK (typeof(confirmed_by_ref) = 'text' AND length(CAST(confirmed_by_ref AS BLOB)) = 36 AND substr(confirmed_by_ref, 1, 4) = 'usr_' AND substr(confirmed_by_ref, 5) NOT GLOB '*[^a-p]*'),
  confirmed_at                TEXT NOT NULL CONSTRAINT ck_bind_confirmed_at CHECK (typeof(confirmed_at) = 'text' AND length(CAST(confirmed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at) IS confirmed_at),
  retired_at                  TEXT CONSTRAINT ck_bind_retired_at CHECK (retired_at IS NULL OR (typeof(retired_at) = 'text' AND length(CAST(retired_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) IS retired_at)),
  created_at                  TEXT NOT NULL CONSTRAINT ck_bind_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_bind_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (card_account_id, issuer, currency) REFERENCES card_accounts(id, issuer, currency) ON DELETE RESTRICT,
  FOREIGN KEY (source, issuer) REFERENCES card_sync_sources(source, issuer) ON DELETE RESTRICT,
  CONSTRAINT ck_bind_status_shape CHECK (((status = 'needs-reconfirmation') = (status_reason IS NOT NULL) AND (status = 'retired') = (retired_at IS NOT NULL)) IS TRUE)
);

-- table card_source_identities on card_source_identities
CREATE TABLE card_source_identities (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_ident_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-ident-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  card_account_id             TEXT NOT NULL,
  source_scope_id             TEXT NOT NULL,
  source_scope_kind           TEXT NOT NULL CONSTRAINT ck_ident_source_scope_kind CHECK (source_scope_kind IN ('known', 'unknown', 'legacy')),
  namespace                   TEXT NOT NULL,
  namespace_kind              TEXT NOT NULL CONSTRAINT ck_ident_namespace_kind CHECK (namespace_kind IN ('legacy-file', 'stable', 'capture')),
  id_hash                     TEXT NOT NULL CONSTRAINT ck_ident_id_hash CHECK (typeof(id_hash) = 'text' AND length(CAST(id_hash AS BLOB)) = 69 AND substr(id_hash, 1, 5) IN ('xid1:', 'cfp1:', 'ccf1:') AND substr(id_hash, 6) NOT GLOB '*[^a-p]*'),
  canonical_transaction_id    TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_ident_status CHECK (status IN ('active', 'detached')),
  first_seen_status           TEXT NOT NULL CONSTRAINT ck_ident_first_seen_status CHECK (first_seen_status IN ('pending', 'posted')),
  created_origin              TEXT NOT NULL CONSTRAINT ck_ident_created_origin CHECK (created_origin IN ('migration', 'file', 'extension', 'session')),
  import_batch_id             TEXT,
  first_observation_id        TEXT REFERENCES card_source_observations(id) ON DELETE RESTRICT,
  created_at                  TEXT NOT NULL CONSTRAINT ck_ident_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  last_seen_at                TEXT CONSTRAINT ck_ident_last_seen_at CHECK (last_seen_at IS NULL OR (typeof(last_seen_at) = 'text' AND length(CAST(last_seen_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at)),
  last_seen_run_id            TEXT REFERENCES card_sync_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_scope_id, card_account_id, source_scope_kind) REFERENCES card_scopes(id, card_account_id, kind) ON DELETE RESTRICT,
  FOREIGN KEY (namespace, namespace_kind) REFERENCES card_sync_namespaces(namespace, kind) ON DELETE RESTRICT,
  FOREIGN KEY (canonical_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, card_account_id) REFERENCES card_import_batches(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_ident_kind_pairing CHECK (((namespace_kind = 'legacy-file') = (source_scope_kind = 'legacy') AND ((namespace_kind = 'stable' AND substr(id_hash, 1, 5) = 'xid1:') OR (namespace_kind = 'capture' AND substr(id_hash, 1, 5) = 'ccf1:') OR (namespace_kind = 'legacy-file' AND substr(id_hash, 1, 5) IN ('xid1:', 'cfp1:')))) IS TRUE),
  CONSTRAINT ck_ident_origin_shape CHECK (((created_origin <> 'extension' OR first_observation_id IS NOT NULL) AND (created_origin <> 'session' OR first_observation_id IS NOT NULL) AND (created_origin <> 'file' OR import_batch_id IS NOT NULL) AND (created_origin IN ('migration', 'file') OR namespace_kind <> 'legacy-file')) IS TRUE)
);

-- table card_source_observations on card_source_observations
CREATE TABLE card_source_observations (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_obs_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-obsrow-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  observation_set_id          TEXT NOT NULL,
  origin                      TEXT NOT NULL CONSTRAINT ck_obs_origin CHECK (origin IN ('extension', 'file')),
  card_account_id             TEXT NOT NULL,
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_obs_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 0 AND 1999),
  file_row_index              INTEGER CONSTRAINT ck_obs_file_row_index CHECK (file_row_index IS NULL OR (file_row_index = CAST(file_row_index AS INTEGER) AND file_row_index BETWEEN 0 AND 9999)),
  source_scope_id             TEXT NOT NULL,
  source_scope_kind           TEXT NOT NULL CONSTRAINT ck_obs_source_scope_kind CHECK (source_scope_kind IN ('known', 'unknown', 'legacy')),
  identity_namespace          TEXT NOT NULL,
  namespace_kind              TEXT NOT NULL CONSTRAINT ck_obs_namespace_kind CHECK (namespace_kind IN ('legacy-file', 'stable', 'capture')),
  external_id_hash            TEXT CONSTRAINT ck_obs_external_id_hash CHECK (external_id_hash IS NULL OR (typeof(external_id_hash) = 'text' AND length(CAST(external_id_hash AS BLOB)) = 69 AND substr(external_id_hash, 1, 5) = 'xid1:' AND substr(external_id_hash, 6) NOT GLOB '*[^a-p]*')),
  fingerprint                 TEXT CONSTRAINT ck_obs_fingerprint CHECK (fingerprint IS NULL OR (typeof(fingerprint) = 'text' AND length(CAST(fingerprint AS BLOB)) = 69 AND substr(fingerprint, 1, 5) = 'cfp1:' AND substr(fingerprint, 6) NOT GLOB '*[^a-p]*')),
  identity_hash               TEXT NOT NULL CONSTRAINT ck_obs_identity_hash CHECK (typeof(identity_hash) = 'text' AND length(CAST(identity_hash AS BLOB)) = 69 AND substr(identity_hash, 1, 5) IN ('xid1:', 'cfp1:', 'ccf1:') AND substr(identity_hash, 6) NOT GLOB '*[^a-p]*'),
  transaction_date            TEXT NOT NULL CONSTRAINT ck_obs_transaction_date CHECK (typeof(transaction_date) = 'text' AND length(CAST(transaction_date AS BLOB)) = 10 AND date(transaction_date) IS transaction_date),
  posted_date                 TEXT CONSTRAINT ck_obs_posted_date CHECK (posted_date IS NULL OR (typeof(posted_date) = 'text' AND length(CAST(posted_date AS BLOB)) = 10 AND date(posted_date) IS posted_date)),
  status                      TEXT NOT NULL CONSTRAINT ck_obs_status CHECK (status IN ('pending', 'posted')),
  amount_minor                INTEGER NOT NULL CONSTRAINT ck_obs_amount_minor CHECK (amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND 999999999999),
  currency                    TEXT NOT NULL CONSTRAINT ck_obs_currency CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  original_amount_minor       INTEGER CONSTRAINT ck_obs_original_amount_minor CHECK (original_amount_minor IS NULL OR (original_amount_minor = CAST(original_amount_minor AS INTEGER) AND original_amount_minor BETWEEN -999999999999 AND 999999999999)),
  original_currency           TEXT CONSTRAINT ck_obs_original_currency CHECK (original_currency IS NULL OR (typeof(original_currency) = 'text' AND length(CAST(original_currency AS BLOB)) = 3 AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  kind                        TEXT NOT NULL CONSTRAINT ck_obs_kind CHECK (kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other')),
  description                 TEXT NOT NULL CONSTRAINT ck_obs_description CHECK (typeof(description) = 'text' AND length(description) BETWEEN 1 AND 500),
  merchant                    TEXT CONSTRAINT ck_obs_merchant CHECK (merchant IS NULL OR (typeof(merchant) = 'text' AND length(merchant) BETWEEN 1 AND 200)),
  issuer_category             TEXT CONSTRAINT ck_obs_issuer_category CHECK (issuer_category IS NULL OR (typeof(issuer_category) = 'text' AND length(issuer_category) BETWEEN 1 AND 100)),
  content_digest              TEXT NOT NULL CONSTRAINT ck_obs_content_digest CHECK (typeof(content_digest) = 'text' AND length(CAST(content_digest AS BLOB)) = 69 AND substr(content_digest, 1, 5) = 'rcd1:' AND substr(content_digest, 6) NOT GLOB '*[^a-p]*'),
  state                       TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_obs_state CHECK (state IN ('open', 'resolved', 'rejected', 'expired')),
  outcome                     TEXT CONSTRAINT ck_obs_outcome CHECK (outcome IS NULL OR (outcome IN ('inserted', 'updated', 'matched', 'attributed', 'unchanged'))),
  resolved_transaction_id     TEXT,
  provenance                  INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_obs_provenance CHECK (provenance IN (0, 1)),
  resolved_plan_id            TEXT CONSTRAINT ck_obs_resolved_plan_id CHECK (resolved_plan_id IS NULL OR (typeof(resolved_plan_id) = 'text' AND length(CAST(resolved_plan_id AS BLOB)) = 36 AND substr(resolved_plan_id, 1, 4) = 'prv_' AND substr(resolved_plan_id, 5) NOT GLOB '*[^a-p]*')),
  resolved_at                 TEXT CONSTRAINT ck_obs_resolved_at CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'text' AND length(CAST(resolved_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at)),
  FOREIGN KEY (observation_set_id, origin) REFERENCES card_sync_observation_sets(id, origin) ON DELETE RESTRICT,
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_scope_id, card_account_id, source_scope_kind) REFERENCES card_scopes(id, card_account_id, kind) ON DELETE RESTRICT,
  FOREIGN KEY (identity_namespace, namespace_kind) REFERENCES card_sync_namespaces(namespace, kind) ON DELETE RESTRICT,
  FOREIGN KEY (card_account_id, currency) REFERENCES card_accounts(id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_obs_identity_one CHECK (((external_id_hash IS NULL) <> (fingerprint IS NULL)) IS TRUE),
  CONSTRAINT ck_obs_identity_form CHECK (((namespace_kind = 'stable' AND external_id_hash IS NOT NULL AND identity_hash = external_id_hash) OR (namespace_kind = 'capture' AND fingerprint IS NOT NULL AND substr(identity_hash, 1, 5) = 'ccf1:') OR (namespace_kind = 'legacy-file' AND identity_hash = coalesce(external_id_hash, fingerprint))) IS TRUE),
  CONSTRAINT ck_obs_legacy_pairing CHECK (((namespace_kind = 'legacy-file') = (source_scope_kind = 'legacy') AND (origin = 'file') = (namespace_kind = 'legacy-file') AND (origin = 'file') = (file_row_index IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_obs_original CHECK (((original_amount_minor IS NULL) = (original_currency IS NULL)) IS TRUE),
  CONSTRAINT ck_obs_pending_no_posted_date CHECK ((origin = 'file' OR status = 'posted' OR posted_date IS NULL) IS TRUE),
  CONSTRAINT ck_obs_state_shape CHECK (((state = 'resolved') = (outcome IS NOT NULL) AND (state = 'resolved') = (resolved_transaction_id IS NOT NULL) AND (state = 'open') = (resolved_at IS NULL) AND (resolved_plan_id IS NULL OR state IN ('resolved', 'rejected'))) IS TRUE),
  CONSTRAINT ck_obs_provenance_shape CHECK ((provenance = 0 OR state IN ('resolved', 'rejected')) IS TRUE)
);

-- table card_sync_audit_events on card_sync_audit_events
CREATE TABLE card_sync_audit_events (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_aud_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-audit-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  event_type                  TEXT NOT NULL CONSTRAINT ck_aud_event_type CHECK (event_type IN ('migration-completed', 'sync-paused', 'sync-resumed', 'policy-changed', 'issuer-enabled', 'issuer-disabled', 'generation-advanced', 'recovery-completed', 'scope-created', 'scope-changed', 'scope-retired', 'binding-created', 'binding-confirmed', 'binding-retired', 'auto-sync-changed', 'pairing-created', 'pairing-redeemed', 'pairing-failed', 'pairing-locked', 'pairing-cancelled', 'pairing-approved', 'pairing-rejected', 'pairing-expired', 'device-revoked', 'device-expired', 'device-regranted', 'run-created', 'run-refused', 'run-aborted', 'run-expired', 'set-accepted', 'set-blocked', 'set-discarded', 'set-expired', 'review-refreshed', 'review-decided', 'plan-prepared', 'plan-committed', 'plan-cancelled', 'receipt-deleted', 'receipt-expired', 'retention-completed', 'ledger-maintenance')),
  actor_kind                  TEXT NOT NULL CONSTRAINT ck_aud_actor_kind CHECK (actor_kind IN ('session', 'device', 'system', 'migration', 'recovery')),
  actor_ref                   TEXT CONSTRAINT ck_aud_actor_ref CHECK (actor_ref IS NULL OR (typeof(actor_ref) = 'text' AND length(CAST(actor_ref AS BLOB)) = 36 AND substr(actor_ref, 1, 4) IN ('usr_', 'dev_') AND substr(actor_ref, 5) NOT GLOB '*[^a-p]*')),
  card_account_id             TEXT CONSTRAINT ck_aud_card_account_id CHECK (card_account_id IS NULL OR (typeof(card_account_id) = 'text' AND length(CAST(card_account_id AS BLOB)) = 42 AND substr(card_account_id, 1, 10) = 'card-acct-' AND substr(card_account_id, 11) NOT GLOB '*[^a-p]*')),
  binding_id                  TEXT CONSTRAINT ck_aud_binding_id CHECK (binding_id IS NULL OR (typeof(binding_id) = 'text' AND length(CAST(binding_id AS BLOB)) = 36 AND substr(binding_id, 1, 4) = 'bnd_' AND substr(binding_id, 5) NOT GLOB '*[^a-p]*')),
  device_id                   TEXT CONSTRAINT ck_aud_device_id CHECK (device_id IS NULL OR (typeof(device_id) = 'text' AND length(CAST(device_id AS BLOB)) = 36 AND substr(device_id, 1, 4) = 'dev_' AND substr(device_id, 5) NOT GLOB '*[^a-p]*')),
  pairing_id                  TEXT CONSTRAINT ck_aud_pairing_id CHECK (pairing_id IS NULL OR (typeof(pairing_id) = 'text' AND length(CAST(pairing_id AS BLOB)) = 36 AND substr(pairing_id, 1, 4) = 'pai_' AND substr(pairing_id, 5) NOT GLOB '*[^a-p]*')),
  run_id                      TEXT CONSTRAINT ck_aud_run_id CHECK (run_id IS NULL OR (typeof(run_id) = 'text' AND length(CAST(run_id AS BLOB)) = 36 AND substr(run_id, 1, 4) = 'run_' AND substr(run_id, 5) NOT GLOB '*[^a-p]*')),
  observation_set_id          TEXT CONSTRAINT ck_aud_observation_set_id CHECK (observation_set_id IS NULL OR (typeof(observation_set_id) = 'text' AND length(CAST(observation_set_id AS BLOB)) = 36 AND substr(observation_set_id, 1, 4) = 'obs_' AND substr(observation_set_id, 5) NOT GLOB '*[^a-p]*')),
  plan_id                     TEXT CONSTRAINT ck_aud_plan_id CHECK (plan_id IS NULL OR (typeof(plan_id) = 'text' AND length(CAST(plan_id AS BLOB)) = 36 AND substr(plan_id, 1, 4) = 'prv_' AND substr(plan_id, 5) NOT GLOB '*[^a-p]*')),
  ledger_event_id             TEXT CONSTRAINT ck_aud_ledger_event_id CHECK (ledger_event_id IS NULL OR (typeof(ledger_event_id) = 'text' AND length(CAST(ledger_event_id AS BLOB)) = 43 AND substr(ledger_event_id, 1, 11) = 'card-event-' AND substr(ledger_event_id, 12) NOT GLOB '*[^a-p]*')),
  code                        TEXT CONSTRAINT ck_aud_code CHECK (code IS NULL OR (typeof(code) = 'text' AND length(CAST(code AS BLOB)) BETWEEN 3 AND 40 AND code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z-]*')),
  version_before              INTEGER CONSTRAINT ck_aud_version_before CHECK (version_before IS NULL OR (version_before = CAST(version_before AS INTEGER) AND version_before BETWEEN 0 AND 2147483647)),
  version_after               INTEGER CONSTRAINT ck_aud_version_after CHECK (version_after IS NULL OR (version_after = CAST(version_after AS INTEGER) AND version_after BETWEEN 0 AND 2147483647)),
  row_count                   INTEGER CONSTRAINT ck_aud_row_count CHECK (row_count IS NULL OR (row_count = CAST(row_count AS INTEGER) AND row_count BETWEEN 0 AND 1000000)),
  byte_count                  INTEGER CONSTRAINT ck_aud_byte_count CHECK (byte_count IS NULL OR (byte_count = CAST(byte_count AS INTEGER) AND byte_count BETWEEN 0 AND 1073741824)),
  item_count                  INTEGER CONSTRAINT ck_aud_item_count CHECK (item_count IS NULL OR (item_count = CAST(item_count AS INTEGER) AND item_count BETWEEN 0 AND 1000000)),
  authorization_generation    TEXT CONSTRAINT ck_aud_authorization_generation CHECK (authorization_generation IS NULL OR (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_aud_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CONSTRAINT ck_aud_actor CHECK (((actor_kind IN ('session', 'device')) = (actor_ref IS NOT NULL) AND (actor_kind <> 'session' OR substr(actor_ref, 1, 4) = 'usr_') AND (actor_kind <> 'device' OR substr(actor_ref, 1, 4) = 'dev_')) IS TRUE),
  CONSTRAINT ck_aud_versions CHECK ((version_before IS NULL OR version_after IS NULL OR version_after >= version_before) IS TRUE),
  CONSTRAINT ck_aud_ledger_event CHECK (((event_type = 'ledger-maintenance') = (ledger_event_id IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_aud_cutoff_shape CHECK ((code IS NOT 'audit-cutoff' OR (event_type = 'retention-completed' AND actor_kind = 'system')) IS TRUE)
);

-- table card_sync_commit_plans on card_sync_commit_plans
CREATE TABLE card_sync_commit_plans (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_plan_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'prv_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  plan_kind                   TEXT NOT NULL CONSTRAINT ck_plan_plan_kind CHECK (plan_kind IN ('set', 'adjustment')),
  card_account_id             TEXT NOT NULL,
  observation_set_id          TEXT NOT NULL,
  set_version                 INTEGER NOT NULL CONSTRAINT ck_plan_set_version CHECK (set_version = CAST(set_version AS INTEGER) AND set_version BETWEEN 1 AND 2147483647),
  principal_kind              TEXT NOT NULL CONSTRAINT ck_plan_principal_kind CHECK (principal_kind IN ('device', 'session')),
  device_id                   TEXT REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  actor_ref                   TEXT CONSTRAINT ck_plan_actor_ref CHECK (actor_ref IS NULL OR (typeof(actor_ref) = 'text' AND length(CAST(actor_ref AS BLOB)) = 36 AND substr(actor_ref, 1, 4) = 'usr_' AND substr(actor_ref, 5) NOT GLOB '*[^a-p]*')),
  binding_id                  TEXT,
  binding_version             INTEGER CONSTRAINT ck_plan_binding_version CHECK (binding_version IS NULL OR (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647)),
  payload_digest              TEXT CONSTRAINT ck_plan_payload_digest CHECK (payload_digest IS NULL OR (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*')),
  plan_digest                 TEXT NOT NULL CONSTRAINT ck_plan_plan_digest CHECK (typeof(plan_digest) = 'text' AND length(CAST(plan_digest AS BLOB)) = 68 AND substr(plan_digest, 1, 4) = 'pl1:' AND substr(plan_digest, 5) NOT GLOB '*[^a-p]*'),
  auto_eligible               INTEGER NOT NULL CONSTRAINT ck_plan_auto_eligible CHECK (auto_eligible IN (0, 1)),
  source_reviewed             INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_plan_source_reviewed CHECK (source_reviewed IN (0, 1)),
  action_count                INTEGER NOT NULL CONSTRAINT ck_plan_action_count CHECK (action_count = CAST(action_count AS INTEGER) AND action_count BETWEEN 0 AND 9999),
  count_insert                INTEGER NOT NULL CONSTRAINT ck_plan_count_insert CHECK (count_insert = CAST(count_insert AS INTEGER) AND count_insert BETWEEN 0 AND 9999),
  count_update                INTEGER NOT NULL CONSTRAINT ck_plan_count_update CHECK (count_update = CAST(count_update AS INTEGER) AND count_update BETWEEN 0 AND 9999),
  count_unchanged             INTEGER NOT NULL CONSTRAINT ck_plan_count_unchanged CHECK (count_unchanged = CAST(count_unchanged AS INTEGER) AND count_unchanged BETWEEN 0 AND 9999),
  count_aliased               INTEGER NOT NULL CONSTRAINT ck_plan_count_aliased CHECK (count_aliased = CAST(count_aliased AS INTEGER) AND count_aliased BETWEEN 0 AND 9999),
  count_matched               INTEGER NOT NULL CONSTRAINT ck_plan_count_matched CHECK (count_matched = CAST(count_matched AS INTEGER) AND count_matched BETWEEN 0 AND 9999),
  count_attributed            INTEGER NOT NULL CONSTRAINT ck_plan_count_attributed CHECK (count_attributed = CAST(count_attributed AS INTEGER) AND count_attributed BETWEEN 0 AND 9999),
  count_promoted              INTEGER NOT NULL CONSTRAINT ck_plan_count_promoted CHECK (count_promoted = CAST(count_promoted AS INTEGER) AND count_promoted BETWEEN 0 AND 9999),
  count_corrected             INTEGER NOT NULL CONSTRAINT ck_plan_count_corrected CHECK (count_corrected = CAST(count_corrected AS INTEGER) AND count_corrected BETWEEN 0 AND 9999),
  count_rejected              INTEGER NOT NULL CONSTRAINT ck_plan_count_rejected CHECK (count_rejected = CAST(count_rejected AS INTEGER) AND count_rejected BETWEEN 0 AND 9999),
  count_unmatched             INTEGER NOT NULL CONSTRAINT ck_plan_count_unmatched CHECK (count_unmatched = CAST(count_unmatched AS INTEGER) AND count_unmatched BETWEEN 0 AND 9999),
  count_superseded            INTEGER NOT NULL CONSTRAINT ck_plan_count_superseded CHECK (count_superseded = CAST(count_superseded AS INTEGER) AND count_superseded BETWEEN 0 AND 9999),
  ledger_revision             INTEGER NOT NULL CONSTRAINT ck_plan_ledger_revision CHECK (ledger_revision = CAST(ledger_revision AS INTEGER) AND ledger_revision BETWEEN 0 AND 2147483647),
  policy_revision             INTEGER CONSTRAINT ck_plan_policy_revision CHECK (policy_revision IS NULL OR (policy_revision = CAST(policy_revision AS INTEGER) AND policy_revision BETWEEN 1 AND 2147483647)),
  issuer_policy_revision      INTEGER CONSTRAINT ck_plan_issuer_policy_revision CHECK (issuer_policy_revision IS NULL OR (issuer_policy_revision = CAST(issuer_policy_revision AS INTEGER) AND issuer_policy_revision BETWEEN 1 AND 2147483647)),
  contract_version            INTEGER CONSTRAINT ck_plan_contract_version CHECK (contract_version IS NULL OR (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)),
  guard_revision              INTEGER NOT NULL CONSTRAINT ck_plan_guard_revision CHECK (guard_revision = CAST(guard_revision AS INTEGER) AND guard_revision BETWEEN 1 AND 999),
  authorization_generation    TEXT CONSTRAINT ck_plan_authorization_generation CHECK (authorization_generation IS NULL OR (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_plan_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_plan_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  status                      TEXT NOT NULL DEFAULT 'prepared' CONSTRAINT ck_plan_status CHECK (status IN ('prepared', 'consumed', 'expired', 'cancelled')),
  closed_at                   TEXT CONSTRAINT ck_plan_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  cancel_reason               TEXT CONSTRAINT ck_plan_cancel_reason CHECK (cancel_reason IS NULL OR (cancel_reason IN ('superseded', 'decisions-changed', 'aborted', 'generation-changed', 'paused', 'set-closed', 'device-revoked', 'binding-changed', 'recovery'))),
  FOREIGN KEY (observation_set_id, card_account_id) REFERENCES card_sync_observation_sets(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (binding_id, card_account_id) REFERENCES card_source_bindings(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_plan_principal CHECK (((principal_kind = 'device') = (device_id IS NOT NULL) AND (principal_kind = 'session') = (actor_ref IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_plan_device_shape CHECK ((principal_kind = 'session' OR (plan_kind = 'set' AND auto_eligible = 1 AND source_reviewed = 0 AND payload_digest IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_plan_session_shape CHECK ((principal_kind = 'device' OR auto_eligible = 0) IS TRUE),
  CONSTRAINT ck_plan_extension_shape CHECK (((binding_id IS NULL) = (binding_version IS NULL) AND (binding_id IS NULL) = (payload_digest IS NULL) AND (payload_digest IS NULL) = (contract_version IS NULL) AND (payload_digest IS NULL) = (issuer_policy_revision IS NULL) AND (payload_digest IS NULL) = (policy_revision IS NULL) AND (payload_digest IS NULL) = (authorization_generation IS NULL)) IS TRUE),
  CONSTRAINT ck_plan_window CHECK ((expires_at > created_at AND (julianday(expires_at) - julianday(created_at)) * 86400.0 <= 600.001) IS TRUE),
  CONSTRAINT ck_plan_status_shape CHECK (((status = 'prepared') = (closed_at IS NULL) AND (status = 'cancelled') = (cancel_reason IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_plan_counts CHECK ((count_insert + count_unchanged + count_aliased + count_matched + count_corrected + count_rejected <= action_count) IS TRUE)
);

-- table card_sync_device_scopes on card_sync_device_scopes
CREATE TABLE card_sync_device_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_dscope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-dscope-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  device_id                   TEXT NOT NULL REFERENCES card_sync_devices(id) ON DELETE CASCADE,
  binding_id                  TEXT NOT NULL REFERENCES card_source_bindings(id) ON DELETE RESTRICT,
  binding_version             INTEGER NOT NULL CONSTRAINT ck_dscope_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  mode                        TEXT NOT NULL CONSTRAINT ck_dscope_mode CHECK (mode IN ('isolated-read', 'main-passive', 'dom-passive')),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_dscope_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999),
  status                      TEXT NOT NULL DEFAULT 'active' CONSTRAINT ck_dscope_status CHECK (status IN ('active', 'revoked')),
  granted_by_ref              TEXT NOT NULL CONSTRAINT ck_dscope_granted_by_ref CHECK (typeof(granted_by_ref) = 'text' AND length(CAST(granted_by_ref AS BLOB)) = 36 AND substr(granted_by_ref, 1, 4) = 'usr_' AND substr(granted_by_ref, 5) NOT GLOB '*[^a-p]*'),
  granted_at                  TEXT NOT NULL CONSTRAINT ck_dscope_granted_at CHECK (typeof(granted_at) = 'text' AND length(CAST(granted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', granted_at) IS granted_at),
  revoked_at                  TEXT CONSTRAINT ck_dscope_revoked_at CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(CAST(revoked_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at)),
  auto_sync                   INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_dscope_auto_sync CHECK (auto_sync IN (0, 1)),
  consent_contract_version    INTEGER CONSTRAINT ck_dscope_consent_contract_version CHECK (consent_contract_version IS NULL OR (consent_contract_version = CAST(consent_contract_version AS INTEGER) AND consent_contract_version BETWEEN 1 AND 999)),
  consent_guard_revision      INTEGER CONSTRAINT ck_dscope_consent_guard_revision CHECK (consent_guard_revision IS NULL OR (consent_guard_revision = CAST(consent_guard_revision AS INTEGER) AND consent_guard_revision BETWEEN 1 AND 999)),
  consent_issuer_revision     INTEGER CONSTRAINT ck_dscope_consent_issuer_revision CHECK (consent_issuer_revision IS NULL OR (consent_issuer_revision = CAST(consent_issuer_revision AS INTEGER) AND consent_issuer_revision BETWEEN 1 AND 2147483647)),
  consent_binding_version     INTEGER CONSTRAINT ck_dscope_consent_binding_version CHECK (consent_binding_version IS NULL OR (consent_binding_version = CAST(consent_binding_version AS INTEGER) AND consent_binding_version BETWEEN 1 AND 2147483647)),
  consent_by_ref              TEXT CONSTRAINT ck_dscope_consent_by_ref CHECK (consent_by_ref IS NULL OR (typeof(consent_by_ref) = 'text' AND length(CAST(consent_by_ref AS BLOB)) = 36 AND substr(consent_by_ref, 1, 4) = 'usr_' AND substr(consent_by_ref, 5) NOT GLOB '*[^a-p]*')),
  consent_at                  TEXT CONSTRAINT ck_dscope_consent_at CHECK (consent_at IS NULL OR (typeof(consent_at) = 'text' AND length(CAST(consent_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', consent_at) IS consent_at)),
  CONSTRAINT ck_dscope_revoked CHECK (((status = 'revoked') = (revoked_at IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_dscope_consent_shape CHECK (((auto_sync = 1) = (consent_at IS NOT NULL) AND (consent_at IS NULL) = (consent_by_ref IS NULL) AND (consent_at IS NULL) = (consent_contract_version IS NULL) AND (consent_at IS NULL) = (consent_guard_revision IS NULL) AND (consent_at IS NULL) = (consent_issuer_revision IS NULL) AND (consent_at IS NULL) = (consent_binding_version IS NULL) AND (auto_sync = 0 OR (status = 'active' AND consent_binding_version = binding_version))) IS TRUE)
);

-- table card_sync_devices on card_sync_devices
CREATE TABLE card_sync_devices (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_dev_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'dev_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  pairing_id                  TEXT NOT NULL REFERENCES card_sync_pairings(id) ON DELETE RESTRICT,
  token_digest                TEXT CONSTRAINT ck_dev_token_digest CHECK (token_digest IS NULL OR (typeof(token_digest) = 'text' AND length(CAST(token_digest AS BLOB)) = 69 AND substr(token_digest, 1, 5) = 'hdh1:' AND substr(token_digest, 6) NOT GLOB '*[^a-p]*')),
  fingerprint                 TEXT NOT NULL CONSTRAINT ck_dev_fingerprint CHECK (typeof(fingerprint) = 'text' AND length(CAST(fingerprint AS BLOB)) = 16 AND fingerprint NOT GLOB '*[^a-p]*'),
  label                       TEXT NOT NULL CONSTRAINT ck_dev_label CHECK (typeof(label) = 'text' AND length(CAST(label AS BLOB)) BETWEEN 1 AND 40 AND label GLOB '[A-Za-z]*' AND label NOT GLOB '*[^A-Za-z0-9 ._-]*'),
  client_version              TEXT NOT NULL CONSTRAINT ck_dev_client_version CHECK (typeof(client_version) = 'text' AND length(CAST(client_version AS BLOB)) BETWEEN 5 AND 11 AND client_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND client_version NOT GLOB '*[^0-9.]*'),
  owner_ref                   TEXT NOT NULL CONSTRAINT ck_dev_owner_ref CHECK (typeof(owner_ref) = 'text' AND length(CAST(owner_ref AS BLOB)) = 36 AND substr(owner_ref, 1, 4) = 'usr_' AND substr(owner_ref, 5) NOT GLOB '*[^a-p]*'),
  status                      TEXT NOT NULL DEFAULT 'pending' CONSTRAINT ck_dev_status CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  created_at                  TEXT NOT NULL CONSTRAINT ck_dev_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  pending_expires_at          TEXT NOT NULL CONSTRAINT ck_dev_pending_expires_at CHECK (typeof(pending_expires_at) = 'text' AND length(CAST(pending_expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', pending_expires_at) IS pending_expires_at),
  activated_at                TEXT CONSTRAINT ck_dev_activated_at CHECK (activated_at IS NULL OR (typeof(activated_at) = 'text' AND length(CAST(activated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) IS activated_at)),
  activated_by_ref            TEXT CONSTRAINT ck_dev_activated_by_ref CHECK (activated_by_ref IS NULL OR (typeof(activated_by_ref) = 'text' AND length(CAST(activated_by_ref AS BLOB)) = 36 AND substr(activated_by_ref, 1, 4) = 'usr_' AND substr(activated_by_ref, 5) NOT GLOB '*[^a-p]*')),
  expires_at                  TEXT CONSTRAINT ck_dev_expires_at CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at)),
  closed_at                   TEXT CONSTRAINT ck_dev_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  close_reason                TEXT CONSTRAINT ck_dev_close_reason CHECK (close_reason IS NULL OR (close_reason IN ('owner', 'rejected', 'rotated', 'recovery', 'pending-expired', 'expired', 'password-reset'))),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_dev_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  last_used_at                TEXT CONSTRAINT ck_dev_last_used_at CHECK (last_used_at IS NULL OR (typeof(last_used_at) = 'text' AND length(CAST(last_used_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at)),
  CONSTRAINT ck_dev_pending_window CHECK ((pending_expires_at > created_at AND (julianday(pending_expires_at) - julianday(created_at)) * 86400.0 <= 600.001) IS TRUE),
  CONSTRAINT ck_dev_token_shape CHECK (((status IN ('pending', 'active')) = (token_digest IS NOT NULL) AND (status IN ('pending', 'active')) = (closed_at IS NULL) AND (closed_at IS NULL) = (close_reason IS NULL)) IS TRUE),
  CONSTRAINT ck_dev_activation_shape CHECK (((activated_at IS NULL) = (activated_by_ref IS NULL) AND (activated_at IS NULL) = (expires_at IS NULL) AND (status <> 'active' OR activated_at IS NOT NULL) AND (status <> 'pending' OR activated_at IS NULL)) IS TRUE),
  CONSTRAINT ck_dev_lifetime CHECK ((expires_at IS NULL OR (expires_at > activated_at AND julianday(expires_at) - julianday(activated_at) <= 30.0)) IS TRUE),
  CONSTRAINT ck_dev_close_reason_shape CHECK ((status IN ('pending', 'active') OR (status = 'expired' AND close_reason IN ('pending-expired', 'expired')) OR (status = 'revoked' AND close_reason IN ('owner', 'rejected', 'rotated', 'recovery', 'password-reset'))) IS TRUE)
);

-- table card_sync_issuer_policy on card_sync_issuer_policy
CREATE TABLE card_sync_issuer_policy (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_ipol_id CHECK (id IN ('amex', 'chase', 'citi', 'wellsfargo')),
  enabled                     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_ipol_enabled CHECK (enabled IN (0, 1)),
  enabled_at                  TEXT CONSTRAINT ck_ipol_enabled_at CHECK (enabled_at IS NULL OR (typeof(enabled_at) = 'text' AND length(CAST(enabled_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', enabled_at) IS enabled_at)),
  approved_contract_version   INTEGER CONSTRAINT ck_ipol_approved_contract_version CHECK (approved_contract_version IS NULL OR (approved_contract_version = CAST(approved_contract_version AS INTEGER) AND approved_contract_version BETWEEN 1 AND 999)),
  risk_acknowledged_at        TEXT CONSTRAINT ck_ipol_risk_acknowledged_at CHECK (risk_acknowledged_at IS NULL OR (typeof(risk_acknowledged_at) = 'text' AND length(CAST(risk_acknowledged_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', risk_acknowledged_at) IS risk_acknowledged_at)),
  main_passive_accepted       INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_ipol_main_passive_accepted CHECK (main_passive_accepted IN (0, 1)),
  revision                    INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_ipol_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  updated_by_ref              TEXT CONSTRAINT ck_ipol_updated_by_ref CHECK (updated_by_ref IS NULL OR (typeof(updated_by_ref) = 'text' AND length(CAST(updated_by_ref AS BLOB)) = 36 AND substr(updated_by_ref, 1, 4) = 'usr_' AND substr(updated_by_ref, 5) NOT GLOB '*[^a-p]*')),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_ipol_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CONSTRAINT ck_ipol_enabled_shape CHECK (((enabled = 1) = (enabled_at IS NOT NULL) AND (enabled = 0 OR (approved_contract_version IS NOT NULL AND risk_acknowledged_at IS NOT NULL))) IS TRUE),
  CONSTRAINT ck_ipol_main_passive CHECK (((main_passive_accepted = 0 OR id IN ('amex', 'citi')) AND (enabled = 0 OR id NOT IN ('amex', 'citi') OR main_passive_accepted = 1)) IS TRUE)
);

-- table card_sync_namespaces on card_sync_namespaces
CREATE TABLE card_sync_namespaces (
  namespace                   TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_ns_namespace CHECK (typeof(namespace) = 'text' AND length(CAST(namespace AS BLOB)) BETWEEN 6 AND 48 AND namespace NOT GLOB '*[^a-z0-9:-]*' AND (namespace GLOB '[a-z]*:v[1-9]' OR namespace GLOB '[a-z]*:v[1-9][0-9]')),
  kind                        TEXT NOT NULL CONSTRAINT ck_ns_kind CHECK (kind IN ('legacy-file', 'stable', 'capture')),
  source                      TEXT REFERENCES card_sync_sources(source) ON DELETE RESTRICT,
  contract_version            INTEGER CONSTRAINT ck_ns_contract_version CHECK (contract_version IS NULL OR (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)),
  CONSTRAINT ck_ns_source_shape CHECK (((kind = 'legacy-file') = (source IS NULL) AND (source IS NULL) = (contract_version IS NULL)) IS TRUE)
);

-- table card_sync_observation_sets on card_sync_observation_sets
CREATE TABLE card_sync_observation_sets (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_set_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'obs_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  origin                      TEXT NOT NULL CONSTRAINT ck_set_origin CHECK (origin IN ('extension', 'file')),
  card_account_id             TEXT NOT NULL,
  issuer                      TEXT NOT NULL CONSTRAINT ck_set_issuer CHECK (issuer IN ('amex', 'chase', 'citi', 'wellsfargo')),
  currency                    TEXT NOT NULL CONSTRAINT ck_set_currency CHECK (typeof(currency) = 'text' AND length(CAST(currency AS BLOB)) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  run_id                      TEXT,
  device_id                   TEXT REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  binding_id                  TEXT,
  binding_version             INTEGER CONSTRAINT ck_set_binding_version CHECK (binding_version IS NULL OR (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647)),
  capture_id                  TEXT CONSTRAINT ck_set_capture_id CHECK (capture_id IS NULL OR (typeof(capture_id) = 'text' AND length(CAST(capture_id AS BLOB)) = 36 AND substr(capture_id, 1, 4) = 'cpt_' AND substr(capture_id, 5) NOT GLOB '*[^a-p]*')),
  payload_digest              TEXT CONSTRAINT ck_set_payload_digest CHECK (payload_digest IS NULL OR (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*')),
  contract_version            INTEGER CONSTRAINT ck_set_contract_version CHECK (contract_version IS NULL OR (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)),
  mode                        TEXT CONSTRAINT ck_set_mode CHECK (mode IS NULL OR (mode IN ('isolated-read', 'main-passive', 'dom-passive'))),
  observed_at                 TEXT CONSTRAINT ck_set_observed_at CHECK (observed_at IS NULL OR (typeof(observed_at) = 'text' AND length(CAST(observed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at)),
  owner                       TEXT CONSTRAINT ck_set_owner CHECK (owner IS NULL OR (owner IN ('alex', 'casey', 'joint'))),
  import_batch_id             TEXT,
  file_chunk                  INTEGER CONSTRAINT ck_set_file_chunk CHECK (file_chunk IS NULL OR (file_chunk = CAST(file_chunk AS INTEGER) AND file_chunk BETWEEN 0 AND 4)),
  source                      TEXT NOT NULL CONSTRAINT ck_set_source CHECK (typeof(source) = 'text' AND length(CAST(source AS BLOB)) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9-]*'),
  parser_version              TEXT NOT NULL CONSTRAINT ck_set_parser_version CHECK (typeof(parser_version) = 'text' AND length(CAST(parser_version AS BLOB)) BETWEEN 1 AND 64 AND parser_version GLOB '[A-Za-z0-9]*' AND parser_version NOT GLOB '*[^A-Za-z0-9._@+-]*'),
  authorization_generation    TEXT CONSTRAINT ck_set_authorization_generation CHECK (authorization_generation IS NULL OR (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*')),
  guard_revision              INTEGER NOT NULL CONSTRAINT ck_set_guard_revision CHECK (guard_revision = CAST(guard_revision AS INTEGER) AND guard_revision BETWEEN 1 AND 999),
  accepted_at                 TEXT NOT NULL CONSTRAINT ck_set_accepted_at CHECK (typeof(accepted_at) = 'text' AND length(CAST(accepted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_set_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  state                       TEXT NOT NULL CONSTRAINT ck_set_state CHECK (state IN ('accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed')),
  version                     INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_set_version CHECK (version = CAST(version AS INTEGER) AND version BETWEEN 1 AND 2147483647),
  review_ledger_revision      INTEGER NOT NULL CONSTRAINT ck_set_review_ledger_revision CHECK (review_ledger_revision = CAST(review_ledger_revision AS INTEGER) AND review_ledger_revision BETWEEN 0 AND 2147483647),
  row_count                   INTEGER NOT NULL CONSTRAINT ck_set_row_count CHECK (row_count = CAST(row_count AS INTEGER) AND row_count BETWEEN 0 AND 2000),
  byte_count                  INTEGER NOT NULL CONSTRAINT ck_set_byte_count CHECK (byte_count = CAST(byte_count AS INTEGER) AND byte_count BETWEEN 0 AND 2097152),
  producer_rejected_count     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_producer_rejected_count CHECK (producer_rejected_count = CAST(producer_rejected_count AS INTEGER) AND producer_rejected_count BETWEEN 0 AND 2000),
  statement_present           INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_statement_present CHECK (statement_present IN (0, 1)),
  statement_charges_minor     INTEGER CONSTRAINT ck_set_statement_charges_minor CHECK (statement_charges_minor IS NULL OR (statement_charges_minor = CAST(statement_charges_minor AS INTEGER) AND statement_charges_minor BETWEEN -999999999999 AND 999999999999)),
  statement_credits_minor     INTEGER CONSTRAINT ck_set_statement_credits_minor CHECK (statement_credits_minor IS NULL OR (statement_credits_minor = CAST(statement_credits_minor AS INTEGER) AND statement_credits_minor BETWEEN -999999999999 AND 999999999999)),
  statement_net_minor         INTEGER CONSTRAINT ck_set_statement_net_minor CHECK (statement_net_minor IS NULL OR (statement_net_minor = CAST(statement_net_minor AS INTEGER) AND statement_net_minor BETWEEN -999999999999 AND 999999999999)),
  statement_previous_balance_minor INTEGER CONSTRAINT ck_set_statement_previous_balance_minor CHECK (statement_previous_balance_minor IS NULL OR (statement_previous_balance_minor = CAST(statement_previous_balance_minor AS INTEGER) AND statement_previous_balance_minor BETWEEN -999999999999 AND 999999999999)),
  statement_new_balance_minor INTEGER CONSTRAINT ck_set_statement_new_balance_minor CHECK (statement_new_balance_minor IS NULL OR (statement_new_balance_minor = CAST(statement_new_balance_minor AS INTEGER) AND statement_new_balance_minor BETWEEN -999999999999 AND 999999999999)),
  open_count                  INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_open_count CHECK (open_count = CAST(open_count AS INTEGER) AND open_count BETWEEN 0 AND 2000),
  inserted_count              INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_inserted_count CHECK (inserted_count = CAST(inserted_count AS INTEGER) AND inserted_count BETWEEN 0 AND 2000),
  updated_count               INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_updated_count CHECK (updated_count = CAST(updated_count AS INTEGER) AND updated_count BETWEEN 0 AND 2000),
  matched_count               INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_matched_count CHECK (matched_count = CAST(matched_count AS INTEGER) AND matched_count BETWEEN 0 AND 2000),
  attributed_count            INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_attributed_count CHECK (attributed_count = CAST(attributed_count AS INTEGER) AND attributed_count BETWEEN 0 AND 2000),
  unchanged_count             INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_unchanged_count CHECK (unchanged_count = CAST(unchanged_count AS INTEGER) AND unchanged_count BETWEEN 0 AND 2000),
  rejected_count              INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_rejected_count CHECK (rejected_count = CAST(rejected_count AS INTEGER) AND rejected_count BETWEEN 0 AND 2000),
  expired_count               INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_set_expired_count CHECK (expired_count = CAST(expired_count AS INTEGER) AND expired_count BETWEEN 0 AND 2000),
  receipt_state               TEXT NOT NULL CONSTRAINT ck_set_receipt_state CHECK (receipt_state IN ('none', 'kept', 'expired', 'deleted')),
  closed_at                   TEXT CONSTRAINT ck_set_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  close_reason                TEXT CONSTRAINT ck_set_close_reason CHECK (close_reason IS NULL OR (close_reason IN ('committed', 'discarded', 'expired'))),
  discard_reason              TEXT CONSTRAINT ck_set_discard_reason CHECK (discard_reason IS NULL OR (discard_reason IN ('not-mine', 'wrong-binding', 'duplicate-of-file', 'bad-data', 'other'))),
  closed_by_ref               TEXT CONSTRAINT ck_set_closed_by_ref CHECK (closed_by_ref IS NULL OR (typeof(closed_by_ref) = 'text' AND length(CAST(closed_by_ref AS BLOB)) = 36 AND substr(closed_by_ref, 1, 4) = 'usr_' AND substr(closed_by_ref, 5) NOT GLOB '*[^a-p]*')),
  content_purged_at           TEXT CONSTRAINT ck_set_content_purged_at CHECK (content_purged_at IS NULL OR (typeof(content_purged_at) = 'text' AND length(CAST(content_purged_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', content_purged_at) IS content_purged_at)),
  FOREIGN KEY (card_account_id, issuer, currency) REFERENCES card_accounts(id, issuer, currency) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, card_account_id) REFERENCES card_sync_runs(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (binding_id, card_account_id, source) REFERENCES card_source_bindings(id, card_account_id, source) ON DELETE RESTRICT,
  FOREIGN KEY (source, issuer, mode) REFERENCES card_sync_sources(source, issuer, mode) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, card_account_id) REFERENCES card_import_batches(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_set_extension_shape CHECK ((origin = 'file' OR (run_id IS NOT NULL AND device_id IS NOT NULL AND binding_id IS NOT NULL AND binding_version IS NOT NULL AND capture_id IS NOT NULL AND payload_digest IS NOT NULL AND contract_version IS NOT NULL AND mode IS NOT NULL AND observed_at IS NOT NULL AND authorization_generation IS NOT NULL AND import_batch_id IS NULL AND file_chunk IS NULL AND byte_count >= 2 AND row_count + producer_rejected_count <= 2000 AND receipt_state <> 'none')) IS TRUE),
  CONSTRAINT ck_set_file_shape CHECK ((origin = 'extension' OR (import_batch_id IS NOT NULL AND file_chunk IS NOT NULL AND run_id IS NULL AND device_id IS NULL AND binding_id IS NULL AND binding_version IS NULL AND capture_id IS NULL AND payload_digest IS NULL AND contract_version IS NULL AND mode IS NULL AND observed_at IS NULL AND authorization_generation IS NULL AND owner IS NULL AND statement_present = 0 AND byte_count = 0 AND producer_rejected_count = 0 AND receipt_state = 'none' AND row_count >= 1 AND state IN ('needs-review', 'committed', 'rejected', 'expired-unreviewed'))) IS TRUE),
  CONSTRAINT ck_set_statement_shape CHECK ((statement_present = 1 OR (statement_charges_minor IS NULL AND statement_credits_minor IS NULL AND statement_net_minor IS NULL AND statement_previous_balance_minor IS NULL AND statement_new_balance_minor IS NULL)) IS TRUE),
  CONSTRAINT ck_set_window CHECK ((expires_at > accepted_at AND julianday(expires_at) - julianday(accepted_at) <= 90.0) IS TRUE),
  CONSTRAINT ck_set_counts CHECK ((open_count + inserted_count + updated_count + matched_count + attributed_count + unchanged_count + rejected_count + expired_count = row_count) IS TRUE),
  CONSTRAINT ck_set_closed_shape CHECK (((state IN ('committed', 'rejected', 'expired-unreviewed')) = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (close_reason IS NULL) AND (closed_at IS NULL OR open_count = 0)) IS TRUE),
  CONSTRAINT ck_set_close_reason_shape CHECK (((state <> 'committed' OR close_reason = 'committed') AND (state <> 'rejected' OR (close_reason = 'discarded' AND closed_by_ref IS NOT NULL)) AND (state <> 'expired-unreviewed' OR close_reason = 'expired') AND (close_reason IS 'discarded') = (discard_reason IS NOT NULL) AND (closed_by_ref IS NULL OR state IN ('committed', 'rejected'))) IS TRUE),
  CONSTRAINT ck_set_open_rows CHECK ((state IN ('committed', 'rejected', 'expired-unreviewed') OR expired_count = 0) IS TRUE),
  CONSTRAINT ck_set_purged CHECK ((content_purged_at IS NULL OR closed_at IS NOT NULL) IS TRUE)
);

-- table card_sync_pairing_scopes on card_sync_pairing_scopes
CREATE TABLE card_sync_pairing_scopes (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_pscope_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 44 AND substr(id, 1, 12) = 'card-pscope-' AND substr(id, 13) NOT GLOB '*[^a-p]*'),
  pairing_id                  TEXT NOT NULL REFERENCES card_sync_pairings(id) ON DELETE CASCADE,
  binding_id                  TEXT NOT NULL REFERENCES card_source_bindings(id) ON DELETE RESTRICT,
  binding_version             INTEGER NOT NULL CONSTRAINT ck_pscope_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  mode                        TEXT NOT NULL CONSTRAINT ck_pscope_mode CHECK (mode IN ('isolated-read', 'main-passive', 'dom-passive')),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_pscope_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)
);

-- table card_sync_pairings on card_sync_pairings
CREATE TABLE card_sync_pairings (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_pair_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'pai_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  code_digest                 TEXT CONSTRAINT ck_pair_code_digest CHECK (code_digest IS NULL OR (typeof(code_digest) = 'text' AND length(CAST(code_digest AS BLOB)) = 69 AND substr(code_digest, 1, 5) = 'hph1:' AND substr(code_digest, 6) NOT GLOB '*[^a-p]*')),
  status                      TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_pair_status CHECK (status IN ('open', 'redeemed', 'approved', 'rejected', 'cancelled', 'expired', 'locked')),
  replaces_device_id          TEXT REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  created_by_ref              TEXT NOT NULL CONSTRAINT ck_pair_created_by_ref CHECK (typeof(created_by_ref) = 'text' AND length(CAST(created_by_ref AS BLOB)) = 36 AND substr(created_by_ref, 1, 4) = 'usr_' AND substr(created_by_ref, 5) NOT GLOB '*[^a-p]*'),
  created_at                  TEXT NOT NULL CONSTRAINT ck_pair_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_pair_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  failed_attempts             INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pair_failed_attempts CHECK (failed_attempts = CAST(failed_attempts AS INTEGER) AND failed_attempts BETWEEN 0 AND 5),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_pair_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  redeemed_at                 TEXT CONSTRAINT ck_pair_redeemed_at CHECK (redeemed_at IS NULL OR (typeof(redeemed_at) = 'text' AND length(CAST(redeemed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', redeemed_at) IS redeemed_at)),
  closed_at                   TEXT CONSTRAINT ck_pair_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  CONSTRAINT ck_pair_window CHECK ((expires_at > created_at AND (julianday(expires_at) - julianday(created_at)) * 86400.0 <= 300.001) IS TRUE),
  CONSTRAINT ck_pair_code_shape CHECK (((status = 'open') = (code_digest IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_pair_closed_shape CHECK (((status IN ('open', 'redeemed')) = (closed_at IS NULL)) IS TRUE),
  CONSTRAINT ck_pair_locked_shape CHECK (((status = 'locked') = (failed_attempts = 5)) IS TRUE),
  CONSTRAINT ck_pair_redeemed_shape CHECK (((status IN ('redeemed', 'approved', 'rejected') AND redeemed_at IS NOT NULL) OR (status IN ('open', 'locked') AND redeemed_at IS NULL) OR status IN ('cancelled', 'expired')) IS TRUE)
);

-- table card_sync_payload_receipts on card_sync_payload_receipts
CREATE TABLE card_sync_payload_receipts (
  observation_set_id          TEXT NOT NULL PRIMARY KEY REFERENCES card_sync_observation_sets(id) ON DELETE RESTRICT,
  payload_digest              TEXT NOT NULL CONSTRAINT ck_rcpt_payload_digest CHECK (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*'),
  canonical_json              TEXT NOT NULL CONSTRAINT ck_rcpt_canonical_json CHECK (typeof(canonical_json) = 'text' AND length(CAST(canonical_json AS BLOB)) BETWEEN 2 AND 2097152 AND substr(canonical_json, 1, 1) = '{'),
  byte_length                 INTEGER NOT NULL CONSTRAINT ck_rcpt_byte_length CHECK (byte_length = CAST(byte_length AS INTEGER) AND byte_length BETWEEN 2 AND 2097152),
  accepted_at                 TEXT NOT NULL CONSTRAINT ck_rcpt_accepted_at CHECK (typeof(accepted_at) = 'text' AND length(CAST(accepted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at),
  expires_at                  TEXT NOT NULL CONSTRAINT ck_rcpt_expires_at CHECK (typeof(expires_at) = 'text' AND length(CAST(expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CONSTRAINT ck_rcpt_length CHECK ((byte_length = length(CAST(canonical_json AS BLOB))) IS TRUE),
  CONSTRAINT ck_rcpt_window CHECK ((expires_at > accepted_at AND julianday(expires_at) - julianday(accepted_at) <= 7.0) IS TRUE)
);

-- table card_sync_plan_actions on card_sync_plan_actions
CREATE TABLE card_sync_plan_actions (
  plan_id                     TEXT NOT NULL,
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_act_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 0 AND 9999),
  card_account_id             TEXT NOT NULL,
  plan_kind                   TEXT NOT NULL CONSTRAINT ck_act_plan_kind CHECK (plan_kind IN ('set', 'adjustment')),
  op                          TEXT NOT NULL CONSTRAINT ck_act_op CHECK (op IN ('insert', 'unchanged', 'alias', 'promote', 'correct', 'match', 'reject', 'accept-difference', 'unmatch', 'restore-attribution', 'revert', 'supersede', 'remove')),
  observation_ordinal         INTEGER CONSTRAINT ck_act_observation_ordinal CHECK (observation_ordinal IS NULL OR (observation_ordinal = CAST(observation_ordinal AS INTEGER) AND observation_ordinal BETWEEN 0 AND 1999)),
  review_item_id              TEXT CONSTRAINT ck_act_review_item_id CHECK (review_item_id IS NULL OR (typeof(review_item_id) = 'text' AND length(CAST(review_item_id AS BLOB)) = 36 AND substr(review_item_id, 1, 4) = 'rvw_' AND substr(review_item_id, 5) NOT GLOB '*[^a-p]*')),
  content_digest              TEXT CONSTRAINT ck_act_content_digest CHECK (content_digest IS NULL OR (typeof(content_digest) = 'text' AND length(CAST(content_digest AS BLOB)) = 69 AND substr(content_digest, 1, 5) = 'rcd1:' AND substr(content_digest, 6) NOT GLOB '*[^a-p]*')),
  transaction_id              TEXT,
  expected_revision           INTEGER CONSTRAINT ck_act_expected_revision CHECK (expected_revision IS NULL OR (expected_revision = CAST(expected_revision AS INTEGER) AND expected_revision BETWEEN 1 AND 2147483647)),
  new_ref                     INTEGER CONSTRAINT ck_act_new_ref CHECK (new_ref IS NULL OR (new_ref = CAST(new_ref AS INTEGER) AND new_ref BETWEEN 0 AND 9999)),
  related_transaction_id      TEXT,
  related_revision            INTEGER CONSTRAINT ck_act_related_revision CHECK (related_revision IS NULL OR (related_revision = CAST(related_revision AS INTEGER) AND related_revision BETWEEN 1 AND 2147483647)),
  scope_id                    TEXT,
  promote                     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_act_promote CHECK (promote IN (0, 1)),
  restore                     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_act_restore CHECK (restore IN (0, 1)),
  identity_count              INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_act_identity_count CHECK (identity_count = CAST(identity_count AS INTEGER) AND identity_count BETWEEN 0 AND 4),
  reverses_event_id           TEXT REFERENCES card_transaction_events(id) ON DELETE RESTRICT,
  CONSTRAINT pk_card_sync_plan_actions PRIMARY KEY (plan_id, ordinal),
  FOREIGN KEY (plan_id, card_account_id, plan_kind) REFERENCES card_sync_commit_plans(id, card_account_id, plan_kind) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_act_kind CHECK (((op IN ('unmatch', 'restore-attribution', 'revert', 'supersede', 'remove')) <= (plan_kind = 'adjustment')) IS TRUE),
  CONSTRAINT ck_act_flags CHECK (((promote = 0 OR op IN ('promote', 'match')) AND (op <> 'promote' OR promote = 1) AND (restore = 0 OR op IN ('promote', 'correct', 'match')) AND (related_revision IS NULL) = (related_transaction_id IS NULL)) IS TRUE),
  CONSTRAINT ck_act_op_insert CHECK ((op <> 'insert' OR (observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND scope_id IS NOT NULL AND transaction_id IS NULL AND expected_revision IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count >= 1)) IS TRUE),
  CONSTRAINT ck_act_op_unchanged CHECK ((op <> 'unchanged' OR (identity_count = 0 AND observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND scope_id IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND ((transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND new_ref IS NULL) OR (transaction_id IS NULL AND expected_revision IS NULL AND new_ref IS NOT NULL AND new_ref < ordinal)))) IS TRUE),
  CONSTRAINT ck_act_op_alias CHECK ((op <> 'alias' OR (identity_count >= 1 AND observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND scope_id IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND ((transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND new_ref IS NULL) OR (transaction_id IS NULL AND expected_revision IS NULL AND new_ref IS NOT NULL AND new_ref < ordinal)))) IS TRUE),
  CONSTRAINT ck_act_op_promote CHECK ((op <> 'promote' OR (observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL)) IS TRUE),
  CONSTRAINT ck_act_op_correct CHECK ((op <> 'correct' OR (observation_ordinal IS NOT NULL AND review_item_id IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_match CHECK ((op <> 'match' OR (observation_ordinal IS NOT NULL AND review_item_id IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count >= 1)) IS TRUE),
  CONSTRAINT ck_act_op_reject CHECK ((op <> 'reject' OR (observation_ordinal IS NOT NULL AND content_digest IS NOT NULL AND transaction_id IS NULL AND expected_revision IS NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_accept_difference CHECK ((op <> 'accept-difference' OR (review_item_id IS NOT NULL AND observation_ordinal IS NULL AND content_digest IS NULL AND transaction_id IS NULL AND expected_revision IS NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_unmatch CHECK ((op <> 'unmatch' OR (observation_ordinal IS NOT NULL AND review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count >= 1 AND (new_ref IS NULL OR new_ref <> ordinal))) IS TRUE),
  CONSTRAINT ck_act_op_restore_attribution CHECK ((op <> 'restore-attribution' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NOT NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_revert CHECK ((op <> 'revert' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND reverses_event_id IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND identity_count = 0)) IS TRUE),
  CONSTRAINT ck_act_op_supersede CHECK ((op <> 'supersede' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND related_transaction_id IS NOT NULL AND related_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND reverses_event_id IS NULL AND transaction_id <> related_transaction_id)) IS TRUE),
  CONSTRAINT ck_act_op_remove CHECK ((op <> 'remove' OR (review_item_id IS NOT NULL AND transaction_id IS NOT NULL AND expected_revision IS NOT NULL AND scope_id IS NULL AND new_ref IS NULL AND related_transaction_id IS NULL AND reverses_event_id IS NULL AND identity_count = 0)) IS TRUE)
);

-- table card_sync_policy on card_sync_policy
CREATE TABLE card_sync_policy (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_pol_id CHECK (id = 'card-sync-policy'),
  revision                    INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_pol_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  paused                      INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_pol_paused CHECK (paused IN (0, 1)),
  paused_at                   TEXT CONSTRAINT ck_pol_paused_at CHECK (paused_at IS NULL OR (typeof(paused_at) = 'text' AND length(CAST(paused_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', paused_at) IS paused_at)),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_pol_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  generation_changed_at       TEXT NOT NULL CONSTRAINT ck_pol_generation_changed_at CHECK (typeof(generation_changed_at) = 'text' AND length(CAST(generation_changed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', generation_changed_at) IS generation_changed_at),
  recovery_completed_at       TEXT CONSTRAINT ck_pol_recovery_completed_at CHECK (recovery_completed_at IS NULL OR (typeof(recovery_completed_at) = 'text' AND length(CAST(recovery_completed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recovery_completed_at) IS recovery_completed_at)),
  review_retention_days       INTEGER NOT NULL DEFAULT 30 CONSTRAINT ck_pol_review_retention_days CHECK (review_retention_days = CAST(review_retention_days AS INTEGER) AND review_retention_days BETWEEN 1 AND 90),
  receipt_retention_days      INTEGER NOT NULL DEFAULT 7 CONSTRAINT ck_pol_receipt_retention_days CHECK (receipt_retention_days = CAST(receipt_retention_days AS INTEGER) AND receipt_retention_days BETWEEN 1 AND 7),
  max_runs_per_device_day     INTEGER NOT NULL DEFAULT 50 CONSTRAINT ck_pol_max_runs_per_device_day CHECK (max_runs_per_device_day = CAST(max_runs_per_device_day AS INTEGER) AND max_runs_per_device_day BETWEEN 1 AND 500),
  quota_account_sets          INTEGER NOT NULL DEFAULT 100 CONSTRAINT ck_pol_quota_account_sets CHECK (quota_account_sets = CAST(quota_account_sets AS INTEGER) AND quota_account_sets BETWEEN 1 AND 1000),
  quota_account_rows          INTEGER NOT NULL DEFAULT 10000 CONSTRAINT ck_pol_quota_account_rows CHECK (quota_account_rows = CAST(quota_account_rows AS INTEGER) AND quota_account_rows BETWEEN 1 AND 100000),
  quota_account_bytes         INTEGER NOT NULL DEFAULT 10485760 CONSTRAINT ck_pol_quota_account_bytes CHECK (quota_account_bytes = CAST(quota_account_bytes AS INTEGER) AND quota_account_bytes BETWEEN 1 AND 104857600),
  quota_device_sets           INTEGER NOT NULL DEFAULT 200 CONSTRAINT ck_pol_quota_device_sets CHECK (quota_device_sets = CAST(quota_device_sets AS INTEGER) AND quota_device_sets BETWEEN 1 AND 2000),
  quota_device_rows           INTEGER NOT NULL DEFAULT 20000 CONSTRAINT ck_pol_quota_device_rows CHECK (quota_device_rows = CAST(quota_device_rows AS INTEGER) AND quota_device_rows BETWEEN 1 AND 200000),
  quota_device_bytes          INTEGER NOT NULL DEFAULT 20971520 CONSTRAINT ck_pol_quota_device_bytes CHECK (quota_device_bytes = CAST(quota_device_bytes AS INTEGER) AND quota_device_bytes BETWEEN 1 AND 209715200),
  quota_global_sets           INTEGER NOT NULL DEFAULT 500 CONSTRAINT ck_pol_quota_global_sets CHECK (quota_global_sets = CAST(quota_global_sets AS INTEGER) AND quota_global_sets BETWEEN 1 AND 5000),
  quota_global_rows           INTEGER NOT NULL DEFAULT 50000 CONSTRAINT ck_pol_quota_global_rows CHECK (quota_global_rows = CAST(quota_global_rows AS INTEGER) AND quota_global_rows BETWEEN 1 AND 500000),
  quota_global_bytes          INTEGER NOT NULL DEFAULT 52428800 CONSTRAINT ck_pol_quota_global_bytes CHECK (quota_global_bytes = CAST(quota_global_bytes AS INTEGER) AND quota_global_bytes BETWEEN 1 AND 524288000),
  updated_by_ref              TEXT CONSTRAINT ck_pol_updated_by_ref CHECK (updated_by_ref IS NULL OR (typeof(updated_by_ref) = 'text' AND length(CAST(updated_by_ref AS BLOB)) = 36 AND substr(updated_by_ref, 1, 4) = 'usr_' AND substr(updated_by_ref, 5) NOT GLOB '*[^a-p]*')),
  updated_at                  TEXT NOT NULL CONSTRAINT ck_pol_updated_at CHECK (typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CONSTRAINT ck_pol_paused_shape CHECK (((paused = 1) = (paused_at IS NOT NULL)) IS TRUE)
);

-- table card_sync_runs on card_sync_runs
CREATE TABLE card_sync_runs (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_run_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 36 AND substr(id, 1, 4) = 'run_' AND substr(id, 5) NOT GLOB '*[^a-p]*'),
  device_id                   TEXT NOT NULL REFERENCES card_sync_devices(id) ON DELETE RESTRICT,
  client_run_id               TEXT NOT NULL CONSTRAINT ck_run_client_run_id CHECK (typeof(client_run_id) = 'text' AND length(CAST(client_run_id AS BLOB)) = 36 AND substr(client_run_id, 1, 4) = 'crn_' AND substr(client_run_id, 5) NOT GLOB '*[^a-p]*'),
  binding_id                  TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  binding_version             INTEGER NOT NULL CONSTRAINT ck_run_binding_version CHECK (binding_version = CAST(binding_version AS INTEGER) AND binding_version BETWEEN 1 AND 2147483647),
  adapter_version             TEXT NOT NULL CONSTRAINT ck_run_adapter_version CHECK (typeof(adapter_version) = 'text' AND length(CAST(adapter_version AS BLOB)) BETWEEN 1 AND 64 AND adapter_version GLOB '[A-Za-z0-9]*' AND adapter_version NOT GLOB '*[^A-Za-z0-9._@+-]*'),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_run_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999),
  run_trigger                 TEXT NOT NULL CONSTRAINT ck_run_run_trigger CHECK (run_trigger IN ('manual', 'auto')),
  authorization_generation    TEXT NOT NULL CONSTRAINT ck_run_authorization_generation CHECK (typeof(authorization_generation) = 'text' AND length(CAST(authorization_generation AS BLOB)) = 36 AND substr(authorization_generation, 1, 4) = 'agn_' AND substr(authorization_generation, 5) NOT GLOB '*[^a-p]*'),
  created_at                  TEXT NOT NULL CONSTRAINT ck_run_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  upload_expires_at           TEXT NOT NULL CONSTRAINT ck_run_upload_expires_at CHECK (typeof(upload_expires_at) = 'text' AND length(CAST(upload_expires_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', upload_expires_at) IS upload_expires_at),
  acceptance_state            TEXT NOT NULL DEFAULT 'open' CONSTRAINT ck_run_acceptance_state CHECK (acceptance_state IN ('open', 'accepted', 'refused', 'expired', 'aborted')),
  payload_digest              TEXT CONSTRAINT ck_run_payload_digest CHECK (payload_digest IS NULL OR (typeof(payload_digest) = 'text' AND length(CAST(payload_digest AS BLOB)) = 68 AND substr(payload_digest, 1, 4) = 'pd1:' AND substr(payload_digest, 5) NOT GLOB '*[^a-p]*')),
  refusal_code                TEXT CONSTRAINT ck_run_refusal_code CHECK (refusal_code IS NULL OR (refusal_code IN ('payload-invalid', 'payload-digest-mismatch', 'too-large', 'card-data', 'review-quota-exceeded', 'binding-stale', 'sync-disabled', 'source-not-authorized', 'scope-not-in-binding', 'contract-unsupported', 'capture-already-accepted'))),
  accepted_at                 TEXT CONSTRAINT ck_run_accepted_at CHECK (accepted_at IS NULL OR (typeof(accepted_at) = 'text' AND length(CAST(accepted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at)),
  closed_at                   TEXT CONSTRAINT ck_run_closed_at CHECK (closed_at IS NULL OR (typeof(closed_at) = 'text' AND length(CAST(closed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS closed_at)),
  aborted_at                  TEXT CONSTRAINT ck_run_aborted_at CHECK (aborted_at IS NULL OR (typeof(aborted_at) = 'text' AND length(CAST(aborted_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', aborted_at) IS aborted_at)),
  abort_reason                TEXT CONSTRAINT ck_run_abort_reason CHECK (abort_reason IS NULL OR (abort_reason IN ('site-permission-revoked', 'not-signed-in', 'unknown-page-structure', 'certificate-error', 'user-cancelled'))),
  FOREIGN KEY (binding_id, card_account_id) REFERENCES card_source_bindings(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_run_window CHECK ((upload_expires_at > created_at AND (julianday(upload_expires_at) - julianday(created_at)) * 86400.0 <= 600.001) IS TRUE),
  CONSTRAINT ck_run_accepted_shape CHECK (((acceptance_state = 'accepted') = (payload_digest IS NOT NULL) AND (acceptance_state = 'accepted') = (accepted_at IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_run_refused_shape CHECK (((acceptance_state = 'refused') = (refusal_code IS NOT NULL)) IS TRUE),
  CONSTRAINT ck_run_closed_shape CHECK (((acceptance_state = 'open') = (closed_at IS NULL)) IS TRUE),
  CONSTRAINT ck_run_abort_shape CHECK (((aborted_at IS NULL) = (abort_reason IS NULL) AND (acceptance_state <> 'aborted' OR aborted_at IS NOT NULL) AND (aborted_at IS NULL OR acceptance_state IN ('aborted', 'accepted'))) IS TRUE)
);

-- table card_sync_set_card_hints on card_sync_set_card_hints
CREATE TABLE card_sync_set_card_hints (
  observation_set_id          TEXT NOT NULL,
  origin                      TEXT NOT NULL CONSTRAINT ck_hint_origin CHECK (origin = 'extension'),
  ordinal                     INTEGER NOT NULL CONSTRAINT ck_hint_ordinal CHECK (ordinal = CAST(ordinal AS INTEGER) AND ordinal BETWEEN 0 AND 19),
  last4                       TEXT NOT NULL CONSTRAINT ck_hint_last4 CHECK (typeof(last4) = 'text' AND length(CAST(last4 AS BLOB)) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]'),
  CONSTRAINT pk_card_sync_set_card_hints PRIMARY KEY (observation_set_id, ordinal),
  FOREIGN KEY (observation_set_id, origin) REFERENCES card_sync_observation_sets(id, origin) ON DELETE CASCADE
);

-- table card_sync_sources on card_sync_sources
CREATE TABLE card_sync_sources (
  source                      TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_src_source CHECK (typeof(source) = 'text' AND length(CAST(source AS BLOB)) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z-]*'),
  issuer                      TEXT NOT NULL CONSTRAINT ck_src_issuer CHECK (issuer IN ('amex', 'chase', 'citi', 'wellsfargo')),
  mode                        TEXT NOT NULL CONSTRAINT ck_src_mode CHECK (mode IN ('isolated-read', 'main-passive', 'dom-passive')),
  contract_version            INTEGER NOT NULL CONSTRAINT ck_src_contract_version CHECK (contract_version = CAST(contract_version AS INTEGER) AND contract_version BETWEEN 1 AND 999)
);

-- table card_transaction_events on card_transaction_events
CREATE TABLE card_transaction_events (
  id                          TEXT NOT NULL PRIMARY KEY CONSTRAINT ck_evt_id CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 43 AND substr(id, 1, 11) = 'card-event-' AND substr(id, 12) NOT GLOB '*[^a-p]*'),
  card_transaction_id         TEXT NOT NULL,
  card_account_id             TEXT NOT NULL,
  event_type                  TEXT NOT NULL CONSTRAINT ck_evt_event_type CHECK (event_type IN ('created', 'promoted', 'corrected', 'identity-linked', 'attributed', 'identity-repointed', 'identity-detached', 'superseded', 'settled-into', 'removed', 'restored', 'reversed', 'user-edited')),
  transaction_revision        INTEGER NOT NULL CONSTRAINT ck_evt_transaction_revision CHECK (transaction_revision = CAST(transaction_revision AS INTEGER) AND transaction_revision BETWEEN 1 AND 2147483647),
  origin                      TEXT NOT NULL CONSTRAINT ck_evt_origin CHECK (origin IN ('file', 'extension', 'session')),
  actor_kind                  TEXT NOT NULL CONSTRAINT ck_evt_actor_kind CHECK (actor_kind IN ('session', 'device', 'system')),
  actor_ref                   TEXT CONSTRAINT ck_evt_actor_ref CHECK (actor_ref IS NULL OR (typeof(actor_ref) = 'text' AND length(CAST(actor_ref AS BLOB)) = 36 AND substr(actor_ref, 1, 4) IN ('usr_', 'dev_') AND substr(actor_ref, 5) NOT GLOB '*[^a-p]*')),
  import_batch_id             TEXT REFERENCES card_import_batches(id) ON DELETE RESTRICT,
  run_id                      TEXT REFERENCES card_sync_runs(id) ON DELETE RESTRICT,
  observation_set_id          TEXT REFERENCES card_sync_observation_sets(id) ON DELETE RESTRICT,
  observation_id              TEXT REFERENCES card_source_observations(id) ON DELETE RESTRICT,
  identity_id                 TEXT REFERENCES card_source_identities(id) ON DELETE RESTRICT,
  plan_id                     TEXT CONSTRAINT ck_evt_plan_id CHECK (plan_id IS NULL OR (typeof(plan_id) = 'text' AND length(CAST(plan_id AS BLOB)) = 36 AND substr(plan_id, 1, 4) = 'prv_' AND substr(plan_id, 5) NOT GLOB '*[^a-p]*')),
  plan_digest                 TEXT CONSTRAINT ck_evt_plan_digest CHECK (plan_digest IS NULL OR (typeof(plan_digest) = 'text' AND length(CAST(plan_digest AS BLOB)) = 68 AND substr(plan_digest, 1, 4) = 'pl1:' AND substr(plan_digest, 5) NOT GLOB '*[^a-p]*')),
  related_transaction_id      TEXT,
  cause_event_id              TEXT REFERENCES card_transaction_events(id) ON DELETE RESTRICT,
  reverses_event_id           TEXT REFERENCES card_transaction_events(id) ON DELETE RESTRICT,
  reason                      TEXT NOT NULL CONSTRAINT ck_evt_reason CHECK (reason IN ('insert', 'dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'pending-posted', 'posted-correction', 'same-transaction', 'alias', 'attribution', 'user-edit', 'restore', 'adjustment', 'maintenance')),
  from_status                 TEXT CONSTRAINT ck_evt_from_status CHECK (from_status IS NULL OR (from_status IN ('pending', 'posted', 'removed'))),
  to_status                   TEXT CONSTRAINT ck_evt_to_status CHECK (to_status IS NULL OR (to_status IN ('pending', 'posted', 'removed'))),
  from_amount_minor           INTEGER CONSTRAINT ck_evt_from_amount_minor CHECK (from_amount_minor IS NULL OR (from_amount_minor = CAST(from_amount_minor AS INTEGER) AND from_amount_minor BETWEEN -999999999999 AND 999999999999)),
  to_amount_minor             INTEGER CONSTRAINT ck_evt_to_amount_minor CHECK (to_amount_minor IS NULL OR (to_amount_minor = CAST(to_amount_minor AS INTEGER) AND to_amount_minor BETWEEN -999999999999 AND 999999999999)),
  from_transaction_date       TEXT CONSTRAINT ck_evt_from_transaction_date CHECK (from_transaction_date IS NULL OR (typeof(from_transaction_date) = 'text' AND length(CAST(from_transaction_date AS BLOB)) = 10 AND from_transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  to_transaction_date         TEXT CONSTRAINT ck_evt_to_transaction_date CHECK (to_transaction_date IS NULL OR (typeof(to_transaction_date) = 'text' AND length(CAST(to_transaction_date AS BLOB)) = 10 AND to_transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  from_posted_date            TEXT CONSTRAINT ck_evt_from_posted_date CHECK (from_posted_date IS NULL OR (typeof(from_posted_date) = 'text' AND length(CAST(from_posted_date AS BLOB)) = 10 AND from_posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  to_posted_date              TEXT CONSTRAINT ck_evt_to_posted_date CHECK (to_posted_date IS NULL OR (typeof(to_posted_date) = 'text' AND length(CAST(to_posted_date AS BLOB)) = 10 AND to_posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  from_kind                   TEXT CONSTRAINT ck_evt_from_kind CHECK (from_kind IS NULL OR (from_kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'))),
  to_kind                     TEXT CONSTRAINT ck_evt_to_kind CHECK (to_kind IS NULL OR (to_kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other'))),
  from_scope_id               TEXT CONSTRAINT ck_evt_from_scope_id CHECK (from_scope_id IS NULL OR (typeof(from_scope_id) = 'text' AND length(CAST(from_scope_id AS BLOB)) = 36 AND substr(from_scope_id, 1, 4) = 'scp_' AND substr(from_scope_id, 5) NOT GLOB '*[^a-p]*')),
  to_scope_id                 TEXT CONSTRAINT ck_evt_to_scope_id CHECK (to_scope_id IS NULL OR (typeof(to_scope_id) = 'text' AND length(CAST(to_scope_id AS BLOB)) = 36 AND substr(to_scope_id, 1, 4) = 'scp_' AND substr(to_scope_id, 5) NOT GLOB '*[^a-p]*')),
  from_canonical_id           TEXT CONSTRAINT ck_evt_from_canonical_id CHECK (from_canonical_id IS NULL OR (typeof(from_canonical_id) = 'text' AND length(CAST(from_canonical_id AS BLOB)) = 41 AND substr(from_canonical_id, 1, 9) = 'card-txn-' AND substr(from_canonical_id, 10) NOT GLOB '*[^a-p]*')),
  to_canonical_id             TEXT CONSTRAINT ck_evt_to_canonical_id CHECK (to_canonical_id IS NULL OR (typeof(to_canonical_id) = 'text' AND length(CAST(to_canonical_id AS BLOB)) = 41 AND substr(to_canonical_id, 1, 9) = 'card-txn-' AND substr(to_canonical_id, 10) NOT GLOB '*[^a-p]*')),
  edit_fields                 INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_evt_edit_fields CHECK (edit_fields = CAST(edit_fields AS INTEGER) AND edit_fields BETWEEN 0 AND 3),
  edit_resolution             TEXT CONSTRAINT ck_evt_edit_resolution CHECK (edit_resolution IS NULL OR (edit_resolution IN ('survivor', 'loser-category', 'loser-notes', 'loser-both'))),
  notify                      INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_evt_notify CHECK (notify IN (0, 1)),
  created_at                  TEXT NOT NULL CONSTRAINT ck_evt_created_at CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  FOREIGN KEY (card_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_evt_actor CHECK (((actor_kind = 'system') = (actor_ref IS NULL) AND (actor_kind <> 'session' OR substr(actor_ref, 1, 4) = 'usr_') AND (actor_kind <> 'device' OR (substr(actor_ref, 1, 4) = 'dev_' AND origin = 'extension' AND event_type IN ('created', 'promoted', 'identity-linked'))) AND (actor_kind <> 'system' OR origin = 'file')) IS TRUE),
  CONSTRAINT ck_evt_origin_shape CHECK (((origin <> 'file' OR import_batch_id IS NOT NULL OR observation_set_id IS NOT NULL) AND (origin <> 'extension' OR (run_id IS NOT NULL AND observation_set_id IS NOT NULL AND observation_id IS NOT NULL)) AND (origin <> 'session' OR (import_batch_id IS NULL AND run_id IS NULL))) IS TRUE),
  CONSTRAINT ck_evt_created CHECK ((event_type <> 'created' OR (from_status IS NULL AND to_status IN ('pending', 'posted') AND to_amount_minor IS NOT NULL AND to_transaction_date IS NOT NULL AND to_kind IS NOT NULL AND to_scope_id IS NOT NULL AND transaction_revision = 1 AND reason = 'insert')) IS TRUE),
  CONSTRAINT ck_evt_promoted CHECK ((event_type <> 'promoted' OR (from_status IN ('pending', 'removed') AND to_status = 'posted' AND from_amount_minor IS NOT NULL AND to_amount_minor IS NOT NULL AND from_transaction_date IS NOT NULL AND to_transaction_date IS NOT NULL AND from_kind IS NOT NULL AND to_kind IS NOT NULL AND reason IN ('pending-posted', 'same-transaction'))) IS TRUE),
  CONSTRAINT ck_evt_corrected CHECK ((event_type <> 'corrected' OR (from_status IN ('pending', 'posted', 'removed') AND to_status IN ('pending', 'posted') AND from_amount_minor IS NOT NULL AND to_amount_minor IS NOT NULL AND from_transaction_date IS NOT NULL AND to_transaction_date IS NOT NULL AND from_kind IS NOT NULL AND to_kind IS NOT NULL AND reason = 'posted-correction')) IS TRUE),
  CONSTRAINT ck_evt_identity CHECK ((event_type NOT IN ('identity-linked', 'identity-repointed', 'identity-detached') OR identity_id IS NOT NULL) IS TRUE),
  CONSTRAINT ck_evt_linked CHECK ((event_type <> 'identity-linked' OR reason IN ('alias', 'same-transaction', 'pending-posted')) IS TRUE),
  CONSTRAINT ck_evt_repointed CHECK ((event_type <> 'identity-repointed' OR (from_canonical_id IS NOT NULL AND to_canonical_id IS NOT NULL AND to_canonical_id = card_transaction_id AND from_canonical_id <> to_canonical_id AND reason IN ('superseded', 'settled-into', 'adjustment', 'maintenance') AND (cause_event_id IS NOT NULL OR reason IN ('adjustment', 'maintenance')))) IS TRUE),
  CONSTRAINT ck_evt_detached CHECK ((event_type <> 'identity-detached' OR (reason IN ('adjustment', 'maintenance') AND from_canonical_id = card_transaction_id)) IS TRUE),
  CONSTRAINT ck_evt_attributed CHECK ((event_type <> 'attributed' OR (from_scope_id IS NOT NULL AND to_scope_id IS NOT NULL AND from_scope_id <> to_scope_id AND reason IN ('attribution', 'adjustment'))) IS TRUE),
  CONSTRAINT ck_evt_merged CHECK ((event_type NOT IN ('superseded', 'settled-into') OR (related_transaction_id IS NOT NULL AND from_status IN ('pending', 'posted') AND to_status = 'removed' AND reason = event_type)) IS TRUE),
  CONSTRAINT ck_evt_removed CHECK ((event_type <> 'removed' OR (reason IN ('dismissed', 'cancelled', 'mistaken-import') AND from_status IN ('pending', 'posted') AND to_status = 'removed')) IS TRUE),
  CONSTRAINT ck_evt_restored CHECK ((event_type <> 'restored' OR (from_status = 'removed' AND to_status IN ('pending', 'posted') AND reason IN ('restore', 'adjustment', 'maintenance'))) IS TRUE),
  CONSTRAINT ck_evt_reversed CHECK (((event_type = 'reversed') = (reverses_event_id IS NOT NULL) AND (event_type <> 'reversed' OR (reason IN ('adjustment', 'maintenance') AND from_status IS NOT NULL AND to_status IS NOT NULL))) IS TRUE),
  CONSTRAINT ck_evt_user_edit CHECK (((event_type = 'user-edited') = (edit_fields > 0) AND (event_type <> 'user-edited' OR reason = 'user-edit') AND (edit_resolution IS NULL OR event_type IN ('superseded', 'settled-into', 'user-edited'))) IS TRUE),
  CONSTRAINT ck_evt_notify_shape CHECK ((notify = 0 OR event_type IN ('promoted', 'corrected', 'reversed')) IS TRUE),
  CONSTRAINT ck_evt_plan CHECK (((plan_id IS NULL) = (plan_digest IS NULL)) IS TRUE)
);

-- table card_transaction_versions on card_transaction_versions
CREATE TABLE card_transaction_versions (
  card_transaction_id         TEXT NOT NULL,
  revision                    INTEGER NOT NULL CONSTRAINT ck_ver_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  card_account_id             TEXT NOT NULL,
  status                      TEXT NOT NULL CONSTRAINT ck_ver_status CHECK (status IN ('pending', 'posted', 'removed')),
  transaction_date            TEXT NOT NULL CONSTRAINT ck_ver_transaction_date CHECK (typeof(transaction_date) = 'text' AND length(CAST(transaction_date AS BLOB)) = 10 AND transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  posted_date                 TEXT CONSTRAINT ck_ver_posted_date CHECK (posted_date IS NULL OR (typeof(posted_date) = 'text' AND length(CAST(posted_date AS BLOB)) = 10 AND posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  amount_minor                INTEGER NOT NULL CONSTRAINT ck_ver_amount_minor CHECK (amount_minor = CAST(amount_minor AS INTEGER) AND amount_minor BETWEEN -999999999999 AND 999999999999),
  original_amount_minor       INTEGER CONSTRAINT ck_ver_original_amount_minor CHECK (original_amount_minor IS NULL OR (original_amount_minor = CAST(original_amount_minor AS INTEGER) AND original_amount_minor BETWEEN -999999999999 AND 999999999999)),
  original_currency           TEXT CONSTRAINT ck_ver_original_currency CHECK (original_currency IS NULL OR (typeof(original_currency) = 'text' AND length(CAST(original_currency AS BLOB)) = 3 AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  kind                        TEXT NOT NULL CONSTRAINT ck_ver_kind CHECK (kind IN ('purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other')),
  description                 TEXT NOT NULL CONSTRAINT ck_ver_description CHECK (typeof(description) = 'text' AND length(description) BETWEEN 1 AND 500),
  merchant                    TEXT CONSTRAINT ck_ver_merchant CHECK (merchant IS NULL OR (typeof(merchant) = 'text' AND length(merchant) BETWEEN 1 AND 200)),
  issuer_category             TEXT CONSTRAINT ck_ver_issuer_category CHECK (issuer_category IS NULL OR (typeof(issuer_category) = 'text' AND length(issuer_category) BETWEEN 1 AND 100)),
  card_scope_id               TEXT NOT NULL CONSTRAINT ck_ver_card_scope_id CHECK (typeof(card_scope_id) = 'text' AND length(CAST(card_scope_id AS BLOB)) = 36 AND substr(card_scope_id, 1, 4) = 'scp_' AND substr(card_scope_id, 5) NOT GLOB '*[^a-p]*'),
  removed_reason              TEXT CONSTRAINT ck_ver_removed_reason CHECK (removed_reason IS NULL OR (removed_reason IN ('dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'legacy'))),
  removed_from_status         TEXT CONSTRAINT ck_ver_removed_from_status CHECK (removed_from_status IS NULL OR (removed_from_status IN ('pending', 'posted'))),
  removed_at                  TEXT CONSTRAINT ck_ver_removed_at CHECK (removed_at IS NULL OR (typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', removed_at) IS removed_at)),
  merged_into_id              TEXT CONSTRAINT ck_ver_merged_into_id CHECK (merged_into_id IS NULL OR (typeof(merged_into_id) = 'text' AND length(CAST(merged_into_id AS BLOB)) = 41 AND substr(merged_into_id, 1, 9) = 'card-txn-' AND substr(merged_into_id, 10) NOT GLOB '*[^a-p]*')),
  dismissed_at                TEXT CONSTRAINT ck_ver_dismissed_at CHECK (dismissed_at IS NULL OR (typeof(dismissed_at) = 'text' AND length(dismissed_at) BETWEEN 20 AND 30)),
  reversal_snapshot_revision  INTEGER CONSTRAINT ck_ver_reversal_snapshot_revision CHECK (reversal_snapshot_revision IS NULL OR (reversal_snapshot_revision = CAST(reversal_snapshot_revision AS INTEGER) AND reversal_snapshot_revision BETWEEN 1 AND 2147483647)),
  replaced_at                 TEXT NOT NULL CONSTRAINT ck_ver_replaced_at CHECK (typeof(replaced_at) = 'text' AND length(CAST(replaced_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', replaced_at) IS replaced_at),
  CONSTRAINT pk_card_transaction_versions PRIMARY KEY (card_transaction_id, revision),
  FOREIGN KEY (card_transaction_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_ver_removed_shape CHECK (((status = 'removed') = (removed_reason IS NOT NULL) AND (status = 'removed') = (removed_at IS NOT NULL)) IS TRUE)
);

-- table card_transactions on card_transactions
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
  dismissed_at           TEXT CHECK (dismissed_at IS NULL OR (
    typeof(dismissed_at) = 'text' AND length(dismissed_at) BETWEEN 20 AND 30 AND status = 'removed')),
  card_scope_id               TEXT NOT NULL,
  revision                    INTEGER NOT NULL DEFAULT 1 CONSTRAINT ck_txn_revision CHECK (revision = CAST(revision AS INTEGER) AND revision BETWEEN 1 AND 2147483647),
  first_sync_run_id           TEXT REFERENCES card_sync_runs(id) ON DELETE RESTRICT,
  removed_reason              TEXT CONSTRAINT ck_txn_removed_reason CHECK (removed_reason IS NULL OR (removed_reason IN ('dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'legacy'))),
  removed_from_status         TEXT CONSTRAINT ck_txn_removed_from_status CHECK (removed_from_status IS NULL OR (removed_from_status IN ('pending', 'posted'))),
  removed_at                  TEXT CONSTRAINT ck_txn_removed_at CHECK (removed_at IS NULL OR (typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', removed_at) IS removed_at)),
  merged_into_id              TEXT,
  reversal_snapshot_revision  INTEGER CONSTRAINT ck_txn_reversal_snapshot_revision CHECK (reversal_snapshot_revision IS NULL OR (reversal_snapshot_revision = CAST(reversal_snapshot_revision AS INTEGER) AND reversal_snapshot_revision BETWEEN 1 AND 2147483647)),
  CHECK ((external_id_hash IS NULL) <> (fingerprint IS NULL)),
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL)),
  CONSTRAINT ck_txn_provenance_one CHECK ((import_batch_id IS NULL OR first_sync_run_id IS NULL) IS TRUE),
  CONSTRAINT ck_txn_removed_shape CHECK (((status = 'removed') = (removed_reason IS NOT NULL) AND (status = 'removed') = (removed_at IS NOT NULL) AND (status = 'removed' OR (removed_from_status IS NULL AND merged_into_id IS NULL))) IS TRUE),
  CONSTRAINT ck_txn_legacy_reason CHECK (((removed_reason IS 'legacy') = (status = 'removed' AND removed_from_status IS NULL)) IS TRUE),
  CONSTRAINT ck_txn_merge_shape CHECK ((coalesce(removed_reason IN ('superseded', 'settled-into'), 0) = (merged_into_id IS NOT NULL) AND merged_into_id IS NOT id) IS TRUE),
  CONSTRAINT ck_txn_reason_from CHECK ((removed_reason IS NULL OR removed_reason IN ('mistaken-import', 'superseded', 'legacy') OR removed_from_status = 'pending') IS TRUE),
  CONSTRAINT ck_txn_dismissed CHECK (((dismissed_at IS NOT NULL) = (removed_reason IS 'dismissed')) IS TRUE),
  CONSTRAINT ck_txn_reversal_marker CHECK ((reversal_snapshot_revision IS NULL OR (status IN ('pending', 'posted') AND reversal_snapshot_revision < revision)) IS TRUE),
  FOREIGN KEY (card_account_id, currency) REFERENCES card_accounts(id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (card_scope_id, card_account_id) REFERENCES card_scopes(id, card_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (merged_into_id, card_account_id) REFERENCES card_transactions(id, card_account_id) ON DELETE RESTRICT
);

-- trigger trg_card_accounts_guard_insert on card_accounts
-- guard: sha256 5b1028f1c12dbaedb602ba1dbf50a67181f81f358a977753606ea52c6fe58029

-- trigger trg_card_accounts_guard_update on card_accounts
-- guard: sha256 592102d893006760b8d7982ac270825dd60e5e2c7caeb97c40403dd783fa2a00

-- trigger trg_card_accounts_inv_ledger_revision on card_accounts
CREATE TRIGGER trg_card_accounts_inv_ledger_revision BEFORE UPDATE OF ledger_revision ON card_accounts
WHEN NEW.ledger_revision < OLD.ledger_revision
BEGIN SELECT RAISE(ABORT, 'card invariant: a ledger revision never decreases'); END;

-- trigger trg_card_accounts_inv_rowid on card_accounts
CREATE TRIGGER trg_card_accounts_inv_rowid BEFORE UPDATE ON card_accounts
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.created_at IS NULL OR NEW.updated_at IS NULL OR NEW.ledger_revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_accounts rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_coverage_windows_guard_insert on card_coverage_windows
-- guard: sha256 1fdd9b17147e7ca291cc8d332d00f7c106b18d11de22946bead7ad41d46a0514

-- trigger trg_card_coverage_windows_guard_update on card_coverage_windows
-- guard: sha256 c799996801b9b8c4c0ffb88e3d2dbd6d0212124783083fc0aac7033a4ad31a17

-- trigger trg_card_coverage_windows_inv_delete on card_coverage_windows
CREATE TRIGGER trg_card_coverage_windows_inv_delete BEFORE DELETE ON card_coverage_windows
WHEN OLD.ledger_state IN ('committed', 'observed-uncommitted')
BEGIN SELECT RAISE(ABORT, 'card invariant: committed coverage is never deleted'); END;

-- trigger trg_card_coverage_windows_inv_no_replace on card_coverage_windows
CREATE TRIGGER trg_card_coverage_windows_inv_no_replace BEFORE INSERT ON card_coverage_windows
WHEN EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.observation_set_id = NEW.observation_set_id AND x.entry_ordinal = NEW.entry_ordinal)
  OR ((NEW.observation_set_id IS NOT NULL) AND EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.observation_set_id = NEW.observation_set_id AND x.card_scope_id = NEW.card_scope_id AND x.status = NEW.status AND x.observation_set_id IS NOT NULL))
  OR EXISTS (SELECT 1 FROM card_coverage_windows x WHERE x.import_batch_id = NEW.import_batch_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_coverage_windows rows are never replaced'); END;

-- trigger trg_card_coverage_windows_inv_rowid on card_coverage_windows
CREATE TRIGGER trg_card_coverage_windows_inv_rowid BEFORE UPDATE ON card_coverage_windows
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'card invariant: card_coverage_windows rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_coverage_windows_inv_update on card_coverage_windows
CREATE TRIGGER trg_card_coverage_windows_inv_update BEFORE UPDATE ON card_coverage_windows
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.source_kind IS NOT OLD.source_kind OR NEW.source IS NOT OLD.source OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.entry_ordinal IS NOT OLD.entry_ordinal OR NEW.status IS NOT OLD.status OR NEW.requested_start IS NOT OLD.requested_start OR NEW.requested_end IS NOT OLD.requested_end OR NEW.requested_basis IS NOT OLD.requested_basis OR NEW.observed_start IS NOT OLD.observed_start OR NEW.observed_end IS NOT OLD.observed_end OR NEW.observed_basis IS NOT OLD.observed_basis OR NEW.claimed_completeness IS NOT OLD.claimed_completeness OR NEW.verified_completeness IS NOT OLD.verified_completeness OR NEW.termination IS NOT OLD.termination OR NEW.page_count IS NOT OLD.page_count OR NEW.evidence IS NOT OLD.evidence OR NEW.observed_at IS NOT OLD.observed_at OR NEW.recorded_at IS NOT OLD.recorded_at
      THEN RAISE(ABORT, 'card invariant: a coverage window records what was observed, once')
    WHEN NEW.ledger_state IS NOT OLD.ledger_state AND NOT (OLD.ledger_state = 'observed-uncommitted' AND NEW.ledger_state IN ('committed', 'expired-unreviewed', 'rejected'))
      THEN RAISE(ABORT, 'card invariant: coverage ledger state change not allowed')
  END;
END;

-- trigger trg_card_identity_contents_guard_insert on card_identity_contents
-- guard: sha256 d4810db4b623d7bb21a3badf4f547d7314df0ac6a469496151faeecd77bf441c

-- trigger trg_card_identity_contents_guard_update on card_identity_contents
-- guard: sha256 7d2f6a33e67914689e231ab5b3339d8b179901765367c94bd0ab454d56f7efff

-- trigger trg_card_identity_contents_inv_no_delete on card_identity_contents
CREATE TRIGGER trg_card_identity_contents_inv_no_delete BEFORE DELETE ON card_identity_contents
BEGIN SELECT RAISE(ABORT, 'card invariant: card_identity_contents rows are never deleted'); END;

-- trigger trg_card_identity_contents_inv_no_replace on card_identity_contents
CREATE TRIGGER trg_card_identity_contents_inv_no_replace BEFORE INSERT ON card_identity_contents
WHEN EXISTS (SELECT 1 FROM card_identity_contents x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_identity_contents x WHERE x.identity_id = NEW.identity_id AND x.content_digest = NEW.content_digest)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_identity_contents rows are never replaced'); END;

-- trigger trg_card_identity_contents_inv_no_update on card_identity_contents
CREATE TRIGGER trg_card_identity_contents_inv_no_update BEFORE UPDATE ON card_identity_contents
BEGIN SELECT RAISE(ABORT, 'card invariant: card_identity_contents rows are append-only'); END;

-- trigger trg_card_import_batches_guard_insert on card_import_batches
-- guard: sha256 e816312099cc28c34c28f7ca4d74586141f7dfb0711870de7effd42b999253b8

-- trigger trg_card_import_batches_guard_update on card_import_batches
-- guard: sha256 7a90512f6682cea2732ccda5b43e1ce56f951e43b027640a0c7a605b93b3ae56

-- trigger trg_card_import_batches_inv_rowid on card_import_batches
CREATE TRIGGER trg_card_import_batches_inv_rowid BEFORE UPDATE ON card_import_batches
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.imported_at IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_import_batches rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_observation_secondary_ids_guard_insert on card_observation_secondary_ids
-- guard: sha256 b222b5c8bb802b2e139d090f268d5ee648d015f1f8cfdfdbc6b6757c87098c0f

-- trigger trg_card_observation_secondary_ids_guard_update on card_observation_secondary_ids
-- guard: sha256 e6bf58eccc95d9340b1f0116070a3c4141420ac370c5835fa34ad742338120ed

-- trigger trg_card_observation_secondary_ids_inv_delete on card_observation_secondary_ids
CREATE TRIGGER trg_card_observation_secondary_ids_inv_delete BEFORE DELETE ON card_observation_secondary_ids
WHEN EXISTS (SELECT 1 FROM card_source_observations o WHERE o.id = OLD.observation_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: secondary ids are deleted only with their observation'); END;

-- trigger trg_card_observation_secondary_ids_inv_no_replace on card_observation_secondary_ids
CREATE TRIGGER trg_card_observation_secondary_ids_inv_no_replace BEFORE INSERT ON card_observation_secondary_ids
WHEN EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.observation_id = NEW.observation_id AND x.ordinal = NEW.ordinal)
  OR EXISTS (SELECT 1 FROM card_observation_secondary_ids x WHERE x.observation_id = NEW.observation_id AND x.namespace = NEW.namespace)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_observation_secondary_ids rows are never replaced'); END;

-- trigger trg_card_observation_secondary_ids_inv_no_update on card_observation_secondary_ids
CREATE TRIGGER trg_card_observation_secondary_ids_inv_no_update BEFORE UPDATE ON card_observation_secondary_ids
BEGIN SELECT RAISE(ABORT, 'card invariant: card_observation_secondary_ids rows are append-only'); END;

-- trigger trg_card_payment_links_guard_insert on card_payment_links
-- guard: sha256 18851aa4474dddc0eb6fb80f4ac726e70f73deba277938b5ee568d90d8482cd0

-- trigger trg_card_payment_links_guard_update on card_payment_links
-- guard: sha256 ba42903eeb27d64092c8518eb4336921de6acde082848be6bbef6659eea4b9fa

-- trigger trg_card_payment_links_inv_no_replace on card_payment_links
CREATE TRIGGER trg_card_payment_links_inv_no_replace BEFORE INSERT ON card_payment_links
WHEN EXISTS (SELECT 1 FROM card_payment_links x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_payment_links x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_payment_links x WHERE x.card_transaction_id = NEW.card_transaction_id AND x.cash_event_ref = NEW.cash_event_ref)
  OR ((NEW.decision = 'confirmed') AND EXISTS (SELECT 1 FROM card_payment_links x WHERE x.card_transaction_id = NEW.card_transaction_id AND x.decision = 'confirmed'))
  OR ((NEW.decision = 'confirmed') AND EXISTS (SELECT 1 FROM card_payment_links x WHERE x.cash_event_ref = NEW.cash_event_ref AND x.decision = 'confirmed'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_payment_links rows are never replaced'); END;

-- trigger trg_card_payment_links_inv_no_update on card_payment_links
CREATE TRIGGER trg_card_payment_links_inv_no_update BEFORE UPDATE ON card_payment_links
BEGIN SELECT RAISE(ABORT, 'card invariant: payment link decisions are replaced, never edited'); END;

-- trigger trg_card_payment_links_inv_payment on card_payment_links
CREATE TRIGGER trg_card_payment_links_inv_payment BEFORE INSERT ON card_payment_links
WHEN NOT EXISTS (SELECT 1 FROM card_transactions t WHERE t.id = NEW.card_transaction_id AND t.kind = 'payment' AND t.status = 'posted' AND t.amount_minor = NEW.amount_minor AND t.currency = NEW.currency)
BEGIN SELECT RAISE(ABORT, 'card invariant: a payment link needs a card payment of that amount and currency'); END;

-- trigger trg_card_reconciliation_candidates_guard_insert on card_reconciliation_candidates
-- guard: sha256 eb78858e16f46fbf40984df65771b1ea3cc6e6cb4c8e0c8888d33e49ae443e56

-- trigger trg_card_reconciliation_candidates_guard_update on card_reconciliation_candidates
-- guard: sha256 e8387444a026c47b6438e6689f4e5e3c2b8c377b35380606374d05bf2ceb5e9b

-- trigger trg_card_reconciliation_candidates_inv_no_replace on card_reconciliation_candidates
CREATE TRIGGER trg_card_reconciliation_candidates_inv_no_replace BEFORE INSERT ON card_reconciliation_candidates
WHEN EXISTS (SELECT 1 FROM card_reconciliation_candidates x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_reconciliation_candidates x WHERE x.review_item_id = NEW.review_item_id AND x.rank = NEW.rank)
  OR EXISTS (SELECT 1 FROM card_reconciliation_candidates x WHERE x.review_item_id = NEW.review_item_id AND x.transaction_id = NEW.transaction_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_reconciliation_candidates rows are never replaced'); END;

-- trigger trg_card_reconciliation_candidates_inv_no_update on card_reconciliation_candidates
CREATE TRIGGER trg_card_reconciliation_candidates_inv_no_update BEFORE UPDATE ON card_reconciliation_candidates
BEGIN SELECT RAISE(ABORT, 'card invariant: candidates are replaced as a list, never edited'); END;

-- trigger trg_card_reconciliation_suggestions_guard_insert on card_reconciliation_suggestions
-- guard: sha256 c7465bc7d83b55613a4af228d0327afb27a126ab3ab50d5c4fae10f443207c56

-- trigger trg_card_reconciliation_suggestions_guard_update on card_reconciliation_suggestions
-- guard: sha256 c33ded5558cec97847fe14be474fa38f67ae92c614e650ca0830497eabd46d66

-- trigger trg_card_reconciliation_suggestions_inv_delete on card_reconciliation_suggestions
CREATE TRIGGER trg_card_reconciliation_suggestions_inv_delete BEFORE DELETE ON card_reconciliation_suggestions
WHEN (OLD.observation_id IS NOT NULL AND EXISTS (SELECT 1 FROM card_source_observations o WHERE o.id = OLD.observation_id))
  OR (OLD.observation_id IS NULL AND (SELECT s.content_purged_at FROM card_sync_observation_sets s WHERE s.id = OLD.observation_set_id) IS NULL)
BEGIN SELECT RAISE(ABORT, 'card invariant: a review item is deleted only with its row or its purged set'); END;

-- trigger trg_card_reconciliation_suggestions_inv_no_replace on card_reconciliation_suggestions
CREATE TRIGGER trg_card_reconciliation_suggestions_inv_no_replace BEFORE INSERT ON card_reconciliation_suggestions
WHEN EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.observation_id = NEW.observation_id)
  OR ((NEW.observation_id IS NULL) AND EXISTS (SELECT 1 FROM card_reconciliation_suggestions x WHERE x.observation_set_id = NEW.observation_set_id AND x.observation_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_reconciliation_suggestions rows are never replaced'); END;

-- trigger trg_card_reconciliation_suggestions_inv_rowid on card_reconciliation_suggestions
CREATE TRIGGER trg_card_reconciliation_suggestions_inv_rowid BEFORE UPDATE ON card_reconciliation_suggestions
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_reconciliation_suggestions rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_reconciliation_suggestions_inv_update on card_reconciliation_suggestions
CREATE TRIGGER trg_card_reconciliation_suggestions_inv_update BEFORE UPDATE ON card_reconciliation_suggestions
BEGIN
  SELECT CASE
    WHEN OLD.status IN ('expired', 'discarded')
      THEN RAISE(ABORT, 'card invariant: a closed review item never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.observation_id IS NOT OLD.observation_id OR NEW.difference_field IS NOT OLD.difference_field OR NEW.expected_minor IS NOT OLD.expected_minor OR NEW.actual_minor IS NOT OLD.actual_minor OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a review item keeps its set and row')
    WHEN OLD.committed_action IS NOT NULL AND (NEW.category IS NOT OLD.category OR NEW.reason IS NOT OLD.reason OR NEW.allowed_actions IS NOT OLD.allowed_actions)
      THEN RAISE(ABORT, 'card invariant: a committed review item keeps its classification')
    WHEN NEW.classified_ledger_revision < OLD.classified_ledger_revision
      THEN RAISE(ABORT, 'card invariant: a review classification never goes back')
    WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'open' AND NEW.status IN ('decided', 'superseded', 'expired', 'discarded')) OR (OLD.status = 'decided' AND NEW.status IN ('open', 'committed', 'superseded', 'expired', 'discarded')) OR (OLD.status = 'committed' AND NEW.status = 'decided') OR (OLD.status = 'superseded' AND NEW.status IN ('open', 'expired', 'discarded')))
      THEN RAISE(ABORT, 'card invariant: review item status change not allowed')
    WHEN NEW.draft_transaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM card_reconciliation_candidates c WHERE c.review_item_id = NEW.id AND c.transaction_id = NEW.draft_transaction_id AND c.blocked_reason IS NOT NULL)
      THEN RAISE(ABORT, 'card invariant: a blocked candidate is never a decision target')
  END;
END;

-- trigger trg_card_scopes_guard_insert on card_scopes
-- guard: sha256 b2407112802eda073f33199604bd8b9575d363e14d824d521d1a9a6a886a6f00

-- trigger trg_card_scopes_guard_update on card_scopes
-- guard: sha256 aee7f4a2964fa1f99695f9d050afb28f1db8ab154b0016f167ab82b6403911df

-- trigger trg_card_scopes_inv_no_delete on card_scopes
CREATE TRIGGER trg_card_scopes_inv_no_delete BEFORE DELETE ON card_scopes
BEGIN SELECT RAISE(ABORT, 'card invariant: card_scopes rows are never deleted'); END;

-- trigger trg_card_scopes_inv_no_replace on card_scopes
CREATE TRIGGER trg_card_scopes_inv_no_replace BEFORE INSERT ON card_scopes
WHEN EXISTS (SELECT 1 FROM card_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_scopes x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_scopes x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_scopes x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id AND x.kind = NEW.kind)
  OR ((NEW.kind = 'legacy') AND EXISTS (SELECT 1 FROM card_scopes x WHERE x.card_account_id = NEW.card_account_id AND x.kind = 'legacy'))
  OR ((NEW.kind = 'unknown') AND EXISTS (SELECT 1 FROM card_scopes x WHERE x.card_account_id = NEW.card_account_id AND x.kind = 'unknown'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_scopes rows are never replaced'); END;

-- trigger trg_card_scopes_inv_rowid on card_scopes
CREATE TRIGGER trg_card_scopes_inv_rowid BEFORE UPDATE ON card_scopes
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.version IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_scopes rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_scopes_inv_update on card_scopes
CREATE TRIGGER trg_card_scopes_inv_update BEFORE UPDATE ON card_scopes
BEGIN
  SELECT CASE
    WHEN OLD.status = 'retired'
      THEN RAISE(ABORT, 'card invariant: a retired card scope never changes')
    WHEN NEW.version IS NOT OLD.version + 1
      THEN RAISE(ABORT, 'card invariant: a card scope version grows by one per update')
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.kind IS NOT OLD.kind OR NEW.last4 IS NOT OLD.last4 OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a card scope keeps its account, kind and card')
  END;
END;

-- trigger trg_card_source_binding_scopes_guard_insert on card_source_binding_scopes
-- guard: sha256 a6973fa1d2401631c5db0a500c13a2d729a4107324332cba0a8327c56b80e531

-- trigger trg_card_source_binding_scopes_guard_update on card_source_binding_scopes
-- guard: sha256 082064e6f93915d08550be0e6a8a967109486bb93a00312f65d3c57571731342

-- trigger trg_card_source_binding_scopes_inv_no_delete on card_source_binding_scopes
CREATE TRIGGER trg_card_source_binding_scopes_inv_no_delete BEFORE DELETE ON card_source_binding_scopes
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_binding_scopes rows are never deleted'); END;

-- trigger trg_card_source_binding_scopes_inv_no_replace on card_source_binding_scopes
CREATE TRIGGER trg_card_source_binding_scopes_inv_no_replace BEFORE INSERT ON card_source_binding_scopes
WHEN EXISTS (SELECT 1 FROM card_source_binding_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_binding_scopes x WHERE x.id = NEW.id)
  OR ((NEW.status = 'active') AND EXISTS (SELECT 1 FROM card_source_binding_scopes x WHERE x.binding_id = NEW.binding_id AND x.card_scope_id = NEW.card_scope_id AND x.status = 'active'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_binding_scopes rows are never replaced'); END;

-- trigger trg_card_source_binding_scopes_inv_rowid on card_source_binding_scopes
CREATE TRIGGER trg_card_source_binding_scopes_inv_rowid BEFORE UPDATE ON card_source_binding_scopes
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_binding_scopes rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_source_binding_scopes_inv_update on card_source_binding_scopes
CREATE TRIGGER trg_card_source_binding_scopes_inv_update BEFORE UPDATE ON card_source_binding_scopes
BEGIN
  SELECT CASE
    WHEN OLD.status = 'revoked'
      THEN RAISE(ABORT, 'card invariant: a revoked binding scope never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.card_scope_kind IS NOT OLD.card_scope_kind OR NEW.binding_version IS NOT OLD.binding_version OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a binding scope keeps its binding and card scope')
  END;
END;

-- trigger trg_card_source_bindings_guard_insert on card_source_bindings
-- guard: sha256 e59f69db6122db52d10b86cdf4cb86c07bf053ab0ce23967817ff6dc2333bf93

-- trigger trg_card_source_bindings_guard_update on card_source_bindings
-- guard: sha256 b84adbd97f23f1c0b6caa808e70632678970814a34944c724945966490b0cef8

-- trigger trg_card_source_bindings_inv_no_delete on card_source_bindings
CREATE TRIGGER trg_card_source_bindings_inv_no_delete BEFORE DELETE ON card_source_bindings
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_bindings rows are never deleted'); END;

-- trigger trg_card_source_bindings_inv_no_replace on card_source_bindings
CREATE TRIGGER trg_card_source_bindings_inv_no_replace BEFORE INSERT ON card_source_bindings
WHEN EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id AND x.source = NEW.source)
  OR ((NEW.status <> 'retired') AND EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.card_account_id = NEW.card_account_id AND x.source = NEW.source AND x.status <> 'retired'))
  OR ((NEW.source_account_digest IS NOT NULL AND NEW.status <> 'retired') AND EXISTS (SELECT 1 FROM card_source_bindings x WHERE x.source = NEW.source AND x.source_account_digest = NEW.source_account_digest AND x.source_account_digest IS NOT NULL AND x.status <> 'retired'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_bindings rows are never replaced'); END;

-- trigger trg_card_source_bindings_inv_rowid on card_source_bindings
CREATE TRIGGER trg_card_source_bindings_inv_rowid BEFORE UPDATE ON card_source_bindings
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.version IS NULL OR NEW.auto_sync_revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_bindings rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_source_bindings_inv_update on card_source_bindings
CREATE TRIGGER trg_card_source_bindings_inv_update BEFORE UPDATE ON card_source_bindings
BEGIN
  SELECT CASE
    WHEN OLD.status = 'retired'
      THEN RAISE(ABORT, 'card invariant: a retired binding never changes')
    WHEN NEW.version IS NOT OLD.version AND NEW.version IS NOT OLD.version + 1
      THEN RAISE(ABORT, 'card invariant: a binding version grows by one per update')
    WHEN NEW.version IS OLD.version AND (NEW.label IS NOT OLD.label OR NEW.status IS NOT OLD.status OR NEW.status_reason IS NOT OLD.status_reason OR NEW.confirmed_by_ref IS NOT OLD.confirmed_by_ref OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.retired_at IS NOT OLD.retired_at)
      THEN RAISE(ABORT, 'card invariant: a binding change bumps its version')
    WHEN NEW.auto_sync_revision IS NOT OLD.auto_sync_revision AND NEW.auto_sync_revision IS NOT OLD.auto_sync_revision + 1
      THEN RAISE(ABORT, 'card invariant: an auto-sync revision grows by one per change')
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.issuer IS NOT OLD.issuer OR NEW.currency IS NOT OLD.currency OR NEW.source IS NOT OLD.source OR NEW.source_account_digest IS NOT OLD.source_account_digest OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a binding keeps its account and source')
  END;
END;

-- trigger trg_card_source_identities_guard_insert on card_source_identities
-- guard: sha256 6b9b5e35d1d4904d7beabffdd5cfc4b2b0abee2c4d8d3f02fba590c51548da2d

-- trigger trg_card_source_identities_guard_update on card_source_identities
-- guard: sha256 b1b31f33220810441e3122815fa09c1572b18de12746adef700df35c5aa66bd9

-- trigger trg_card_source_identities_inv_frozen on card_source_identities
CREATE TRIGGER trg_card_source_identities_inv_frozen BEFORE UPDATE ON card_source_identities
WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.source_scope_id IS NOT OLD.source_scope_id OR NEW.source_scope_kind IS NOT OLD.source_scope_kind OR NEW.namespace IS NOT OLD.namespace OR NEW.namespace_kind IS NOT OLD.namespace_kind OR NEW.id_hash IS NOT OLD.id_hash OR NEW.first_seen_status IS NOT OLD.first_seen_status OR NEW.created_origin IS NOT OLD.created_origin OR NEW.created_at IS NOT OLD.created_at OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.first_observation_id IS NOT OLD.first_observation_id
BEGIN SELECT RAISE(ABORT, 'card invariant: a source identity tuple is immutable'); END;

-- trigger trg_card_source_identities_inv_no_delete on card_source_identities
CREATE TRIGGER trg_card_source_identities_inv_no_delete BEFORE DELETE ON card_source_identities
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_identities rows are never deleted'); END;

-- trigger trg_card_source_identities_inv_no_replace on card_source_identities
CREATE TRIGGER trg_card_source_identities_inv_no_replace BEFORE INSERT ON card_source_identities
WHEN EXISTS (SELECT 1 FROM card_source_identities x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_identities x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_source_identities x WHERE x.card_account_id = NEW.card_account_id AND x.source_scope_id = NEW.source_scope_id AND x.namespace = NEW.namespace AND x.id_hash = NEW.id_hash)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_identities rows are never replaced'); END;

-- trigger trg_card_source_identities_inv_rowid on card_source_identities
CREATE TRIGGER trg_card_source_identities_inv_rowid BEFORE UPDATE ON card_source_identities
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_identities rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_source_identities_inv_target_insert on card_source_identities
CREATE TRIGGER trg_card_source_identities_inv_target_insert BEFORE INSERT ON card_source_identities
WHEN NEW.status = 'active' AND (SELECT t.removed_reason FROM card_transactions t WHERE t.id = NEW.canonical_transaction_id) IN ('superseded', 'settled-into')
BEGIN SELECT RAISE(ABORT, 'card invariant: an identity never points at a merged card transaction'); END;

-- trigger trg_card_source_identities_inv_target_update on card_source_identities
CREATE TRIGGER trg_card_source_identities_inv_target_update BEFORE UPDATE OF canonical_transaction_id, status ON card_source_identities
WHEN NEW.status = 'active' AND (SELECT t.removed_reason FROM card_transactions t WHERE t.id = NEW.canonical_transaction_id) IN ('superseded', 'settled-into')
BEGIN SELECT RAISE(ABORT, 'card invariant: an identity never points at a merged card transaction'); END;

-- trigger trg_card_source_observations_guard_insert on card_source_observations
-- guard: sha256 04674a5690dae983bbd5824237182b3172d49309b06742c2df81e3999b470688

-- trigger trg_card_source_observations_guard_update on card_source_observations
-- guard: sha256 d57eef936ca685c23c71e9293dbdaa87548dfb1172c2ad6a49095a925d30faf7

-- trigger trg_card_source_observations_inv_no_replace on card_source_observations
CREATE TRIGGER trg_card_source_observations_inv_no_replace BEFORE INSERT ON card_source_observations
WHEN EXISTS (SELECT 1 FROM card_source_observations x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_source_observations x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_source_observations x WHERE x.observation_set_id = NEW.observation_set_id AND x.ordinal = NEW.ordinal)
  OR ((NEW.origin = 'file' AND NEW.state = 'open') AND EXISTS (SELECT 1 FROM card_source_observations x WHERE x.card_account_id = NEW.card_account_id AND x.source_scope_id = NEW.source_scope_id AND x.identity_namespace = NEW.identity_namespace AND x.identity_hash = NEW.identity_hash AND x.content_digest = NEW.content_digest AND x.origin = 'file' AND x.state = 'open'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_observations rows are never replaced'); END;

-- trigger trg_card_source_observations_inv_provenance on card_source_observations
CREATE TRIGGER trg_card_source_observations_inv_provenance BEFORE DELETE ON card_source_observations
WHEN OLD.provenance = 1
BEGIN SELECT RAISE(ABORT, 'card invariant: ledger provenance is never deleted'); END;

-- trigger trg_card_source_observations_inv_rowid on card_source_observations
CREATE TRIGGER trg_card_source_observations_inv_rowid BEFORE UPDATE ON card_source_observations
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.state IS NULL OR NEW.provenance IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_source_observations rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_source_observations_inv_update on card_source_observations
CREATE TRIGGER trg_card_source_observations_inv_update BEFORE UPDATE ON card_source_observations
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.origin IS NOT OLD.origin OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.file_row_index IS NOT OLD.file_row_index OR NEW.source_scope_id IS NOT OLD.source_scope_id OR NEW.source_scope_kind IS NOT OLD.source_scope_kind OR NEW.identity_namespace IS NOT OLD.identity_namespace OR NEW.namespace_kind IS NOT OLD.namespace_kind OR NEW.external_id_hash IS NOT OLD.external_id_hash OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.identity_hash IS NOT OLD.identity_hash OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.status IS NOT OLD.status OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.content_digest IS NOT OLD.content_digest
      THEN RAISE(ABORT, 'card invariant: an observation is immutable')
    WHEN OLD.provenance = 1 AND NEW.provenance = 0
      THEN RAISE(ABORT, 'card invariant: ledger provenance is never dropped')
    WHEN OLD.state = 'expired'
      THEN RAISE(ABORT, 'card invariant: an expired observation never changes')
    WHEN NEW.state IS NOT OLD.state AND NOT ((OLD.state = 'open' AND NEW.state IN ('resolved', 'rejected', 'expired')) OR (OLD.state = 'resolved' AND NEW.state = 'rejected') OR (OLD.state = 'rejected' AND NEW.state = 'resolved'))
      THEN RAISE(ABORT, 'card invariant: observation state change not allowed')
  END;
END;

-- trigger trg_card_sync_audit_events_guard_insert on card_sync_audit_events
-- guard: sha256 b2f9a2623e427d8facf0bb35a8edc73374589dbaa383ffb6be499137d009825d

-- trigger trg_card_sync_audit_events_guard_update on card_sync_audit_events
-- guard: sha256 7ed28129da4809a1115869511605014aba9712e0e1e1cdb50a9036206abfa5a2

-- trigger trg_card_sync_audit_events_inv_delete on card_sync_audit_events
CREATE TRIGGER trg_card_sync_audit_events_inv_delete BEFORE DELETE ON card_sync_audit_events
WHEN NOT EXISTS (SELECT 1 FROM card_sync_audit_events r WHERE r.event_type = 'retention-completed' AND r.code = 'audit-cutoff' AND r.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', OLD.created_at, '+365 days'))
BEGIN SELECT RAISE(ABORT, 'card invariant: audit rows are deleted only by retention, 365 days after them'); END;

-- trigger trg_card_sync_audit_events_inv_no_replace on card_sync_audit_events
CREATE TRIGGER trg_card_sync_audit_events_inv_no_replace BEFORE INSERT ON card_sync_audit_events
WHEN EXISTS (SELECT 1 FROM card_sync_audit_events x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_audit_events x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_audit_events rows are never replaced'); END;

-- trigger trg_card_sync_audit_events_inv_no_update on card_sync_audit_events
CREATE TRIGGER trg_card_sync_audit_events_inv_no_update BEFORE UPDATE ON card_sync_audit_events
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_audit_events rows are append-only'); END;

-- trigger trg_card_sync_commit_plans_guard_insert on card_sync_commit_plans
-- guard: sha256 bc2b5cd444263daff48d49f1c5b91e15379e58d0eba68136ca3786370bbd790b

-- trigger trg_card_sync_commit_plans_guard_update on card_sync_commit_plans
-- guard: sha256 f14a0972bd6d3ec04f0762a669be33ce03f8748452d0baafca7849e95edd9f49

-- trigger trg_card_sync_commit_plans_inv_delete on card_sync_commit_plans
CREATE TRIGGER trg_card_sync_commit_plans_inv_delete BEFORE DELETE ON card_sync_commit_plans
WHEN OLD.status = 'prepared'
BEGIN SELECT RAISE(ABORT, 'card invariant: a prepared plan is closed before it is deleted'); END;

-- trigger trg_card_sync_commit_plans_inv_device on card_sync_commit_plans
CREATE TRIGGER trg_card_sync_commit_plans_inv_device BEFORE INSERT ON card_sync_commit_plans
WHEN NEW.principal_kind = 'device'
BEGIN
  SELECT CASE
    WHEN (SELECT s.device_id FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id) IS NOT NEW.device_id
      THEN RAISE(ABORT, 'card invariant: a device plans only its own observation set')
    WHEN (SELECT s.state FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id) IS NOT 'accepted-uncommitted' OR EXISTS (SELECT 1 FROM card_reconciliation_suggestions r WHERE r.observation_set_id = NEW.observation_set_id AND r.status IN ('open', 'decided'))
      THEN RAISE(ABORT, 'card invariant: a device plans only a set that needs no person')
  END;
END;

-- trigger trg_card_sync_commit_plans_inv_expiry on card_sync_commit_plans
CREATE TRIGGER trg_card_sync_commit_plans_inv_expiry BEFORE INSERT ON card_sync_commit_plans
WHEN NEW.expires_at > (SELECT s.expires_at FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: a plan never outlives its observation set'); END;

-- trigger trg_card_sync_commit_plans_inv_no_replace on card_sync_commit_plans
CREATE TRIGGER trg_card_sync_commit_plans_inv_no_replace BEFORE INSERT ON card_sync_commit_plans
WHEN EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id AND x.plan_kind = NEW.plan_kind)
  OR ((NEW.status = 'prepared') AND EXISTS (SELECT 1 FROM card_sync_commit_plans x WHERE x.observation_set_id = NEW.observation_set_id AND x.status = 'prepared'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_commit_plans rows are never replaced'); END;

-- trigger trg_card_sync_commit_plans_inv_rowid on card_sync_commit_plans
CREATE TRIGGER trg_card_sync_commit_plans_inv_rowid BEFORE UPDATE ON card_sync_commit_plans
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.source_reviewed IS NULL OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_commit_plans rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_commit_plans_inv_update on card_sync_commit_plans
CREATE TRIGGER trg_card_sync_commit_plans_inv_update BEFORE UPDATE ON card_sync_commit_plans
BEGIN
  SELECT CASE
    WHEN OLD.status <> 'prepared'
      THEN RAISE(ABORT, 'card invariant: a plan is used at most once')
    WHEN NEW.id IS NOT OLD.id OR NEW.plan_kind IS NOT OLD.plan_kind OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.observation_set_id IS NOT OLD.observation_set_id OR NEW.set_version IS NOT OLD.set_version OR NEW.principal_kind IS NOT OLD.principal_kind OR NEW.device_id IS NOT OLD.device_id OR NEW.actor_ref IS NOT OLD.actor_ref OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.plan_digest IS NOT OLD.plan_digest OR NEW.auto_eligible IS NOT OLD.auto_eligible OR NEW.source_reviewed IS NOT OLD.source_reviewed OR NEW.action_count IS NOT OLD.action_count OR NEW.count_insert IS NOT OLD.count_insert OR NEW.count_update IS NOT OLD.count_update OR NEW.count_unchanged IS NOT OLD.count_unchanged OR NEW.count_aliased IS NOT OLD.count_aliased OR NEW.count_matched IS NOT OLD.count_matched OR NEW.count_attributed IS NOT OLD.count_attributed OR NEW.count_promoted IS NOT OLD.count_promoted OR NEW.count_corrected IS NOT OLD.count_corrected OR NEW.count_rejected IS NOT OLD.count_rejected OR NEW.count_unmatched IS NOT OLD.count_unmatched OR NEW.count_superseded IS NOT OLD.count_superseded OR NEW.ledger_revision IS NOT OLD.ledger_revision OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.issuer_policy_revision IS NOT OLD.issuer_policy_revision OR NEW.contract_version IS NOT OLD.contract_version OR NEW.guard_revision IS NOT OLD.guard_revision OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      THEN RAISE(ABORT, 'card invariant: a prepared plan is immutable')
  END;
END;

-- trigger trg_card_sync_device_scopes_guard_insert on card_sync_device_scopes
-- guard: sha256 1447963e78ef147211277f990c457f6e311b55ba980d85516d078371765ea8ee

-- trigger trg_card_sync_device_scopes_guard_update on card_sync_device_scopes
-- guard: sha256 1c3e3eb77efe33612bafaa02a0ecab1512445e7cdf39085a6111e810440b18fb

-- trigger trg_card_sync_device_scopes_inv_no_replace on card_sync_device_scopes
CREATE TRIGGER trg_card_sync_device_scopes_inv_no_replace BEFORE INSERT ON card_sync_device_scopes
WHEN EXISTS (SELECT 1 FROM card_sync_device_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_device_scopes x WHERE x.id = NEW.id)
  OR ((NEW.status = 'active') AND EXISTS (SELECT 1 FROM card_sync_device_scopes x WHERE x.device_id = NEW.device_id AND x.binding_id = NEW.binding_id AND x.status = 'active'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_device_scopes rows are never replaced'); END;

-- trigger trg_card_sync_device_scopes_inv_rowid on card_sync_device_scopes
CREATE TRIGGER trg_card_sync_device_scopes_inv_rowid BEFORE UPDATE ON card_sync_device_scopes
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.auto_sync IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_device_scopes rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_device_scopes_inv_update on card_sync_device_scopes
CREATE TRIGGER trg_card_sync_device_scopes_inv_update BEFORE UPDATE ON card_sync_device_scopes
BEGIN
  SELECT CASE
    WHEN OLD.status = 'revoked'
      THEN RAISE(ABORT, 'card invariant: a revoked device scope never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.device_id IS NOT OLD.device_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.mode IS NOT OLD.mode OR NEW.contract_version IS NOT OLD.contract_version OR NEW.granted_by_ref IS NOT OLD.granted_by_ref OR NEW.granted_at IS NOT OLD.granted_at
      THEN RAISE(ABORT, 'card invariant: a device scope keeps its device, binding and grant')
  END;
END;

-- trigger trg_card_sync_devices_guard_insert on card_sync_devices
-- guard: sha256 8ad1841da3fb3477e908a6b6fd8cc5cf91454ed733adb4ac24cf7bfad2fd8226

-- trigger trg_card_sync_devices_guard_update on card_sync_devices
-- guard: sha256 81dcc3b7661e9c8943df20daa1921c42fb75658722691705358c84bdab00e9b0

-- trigger trg_card_sync_devices_inv_no_replace on card_sync_devices
CREATE TRIGGER trg_card_sync_devices_inv_no_replace BEFORE INSERT ON card_sync_devices
WHEN EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.pairing_id = NEW.pairing_id)
  OR ((NEW.token_digest IS NOT NULL) AND EXISTS (SELECT 1 FROM card_sync_devices x WHERE x.token_digest = NEW.token_digest AND x.token_digest IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_devices rows are never replaced'); END;

-- trigger trg_card_sync_devices_inv_rowid on card_sync_devices
CREATE TRIGGER trg_card_sync_devices_inv_rowid BEFORE UPDATE ON card_sync_devices
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_devices rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_devices_inv_update on card_sync_devices
CREATE TRIGGER trg_card_sync_devices_inv_update BEFORE UPDATE ON card_sync_devices
BEGIN
  SELECT CASE
    WHEN OLD.status = 'revoked' OR (OLD.status = 'expired' AND NOT coalesce(NEW.status = 'revoked' AND NEW.close_reason IN ('owner', 'password-reset', 'recovery', 'rotated') AND NEW.closed_at IS OLD.closed_at AND NEW.last_used_at IS OLD.last_used_at, 0))
      THEN RAISE(ABORT, 'card invariant: a closed device never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.pairing_id IS NOT OLD.pairing_id OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.label IS NOT OLD.label OR NEW.client_version IS NOT OLD.client_version OR NEW.owner_ref IS NOT OLD.owner_ref OR NEW.created_at IS NOT OLD.created_at OR NEW.pending_expires_at IS NOT OLD.pending_expires_at OR NEW.authorization_generation IS NOT OLD.authorization_generation OR (NOT (OLD.status = 'pending' AND NEW.status = 'active') AND (NEW.expires_at IS NOT OLD.expires_at OR NEW.activated_at IS NOT OLD.activated_at OR NEW.activated_by_ref IS NOT OLD.activated_by_ref))
      THEN RAISE(ABORT, 'card invariant: a device keeps its identity and lifetime')
    WHEN NEW.token_digest IS NOT NULL AND NEW.token_digest IS NOT OLD.token_digest
      THEN RAISE(ABORT, 'card invariant: a device token digest is never replaced')
    WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'revoked', 'expired')) OR (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired')) OR (OLD.status = 'expired' AND NEW.status = 'revoked'))
      THEN RAISE(ABORT, 'card invariant: device status change not allowed')
    WHEN NEW.close_reason IS 'rotated' AND OLD.close_reason IS NOT 'rotated' AND NOT EXISTS (SELECT 1 FROM card_sync_pairings p WHERE p.replaces_device_id = NEW.id AND p.status = 'approved')
      THEN RAISE(ABORT, 'card invariant: a device is rotated only by the approval that replaces it')
  END;
END;

-- trigger trg_card_sync_issuer_policy_guard_insert on card_sync_issuer_policy
-- guard: sha256 a06650ad29caf5695c5c5ef40f03d011ee985da30e6706f529518af0e259e0b8

-- trigger trg_card_sync_issuer_policy_guard_update on card_sync_issuer_policy
-- guard: sha256 59e0a085dadc62bfc3ccb7bae3d5f223c7a5960be611b78ad13d8b5c4a82129a

-- trigger trg_card_sync_issuer_policy_inv_no_delete on card_sync_issuer_policy
CREATE TRIGGER trg_card_sync_issuer_policy_inv_no_delete BEFORE DELETE ON card_sync_issuer_policy
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_issuer_policy rows are never deleted'); END;

-- trigger trg_card_sync_issuer_policy_inv_no_replace on card_sync_issuer_policy
CREATE TRIGGER trg_card_sync_issuer_policy_inv_no_replace BEFORE INSERT ON card_sync_issuer_policy
WHEN EXISTS (SELECT 1 FROM card_sync_issuer_policy x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_issuer_policy x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_issuer_policy rows are never replaced'); END;

-- trigger trg_card_sync_issuer_policy_inv_rowid on card_sync_issuer_policy
CREATE TRIGGER trg_card_sync_issuer_policy_inv_rowid BEFORE UPDATE ON card_sync_issuer_policy
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.enabled IS NULL OR NEW.main_passive_accepted IS NULL OR NEW.revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_issuer_policy rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_issuer_policy_inv_update on card_sync_issuer_policy
CREATE TRIGGER trg_card_sync_issuer_policy_inv_update BEFORE UPDATE ON card_sync_issuer_policy
BEGIN
  SELECT CASE
    WHEN NEW.revision IS NOT OLD.revision + 1 OR NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'card invariant: an issuer policy revision grows by one per update')
  END;
END;

-- trigger trg_card_sync_namespaces_guard_insert on card_sync_namespaces
-- guard: sha256 f49ac282e6546c41f214964d9f9883dac0bacc1e70a54d9a2e395a6ea8f27707

-- trigger trg_card_sync_namespaces_guard_update on card_sync_namespaces
-- guard: sha256 74a717b9eddcab7b607c30f8760900b70fefe2b7b586111599315ae60d936e0d

-- trigger trg_card_sync_namespaces_inv_no_delete on card_sync_namespaces
CREATE TRIGGER trg_card_sync_namespaces_inv_no_delete BEFORE DELETE ON card_sync_namespaces
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are never deleted'); END;

-- trigger trg_card_sync_namespaces_inv_no_replace on card_sync_namespaces
CREATE TRIGGER trg_card_sync_namespaces_inv_no_replace BEFORE INSERT ON card_sync_namespaces
WHEN EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.namespace = NEW.namespace)
  OR EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.namespace = NEW.namespace AND x.kind = NEW.kind)
  OR ((NEW.kind = 'capture') AND EXISTS (SELECT 1 FROM card_sync_namespaces x WHERE x.source = NEW.source AND x.kind = 'capture'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_namespaces rows are never replaced'); END;

-- trigger trg_card_sync_namespaces_inv_no_update on card_sync_namespaces
CREATE TRIGGER trg_card_sync_namespaces_inv_no_update BEFORE UPDATE ON card_sync_namespaces
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are immutable'); END;

-- trigger trg_card_sync_observation_sets_guard_insert on card_sync_observation_sets
-- guard: sha256 d1366faebb88952f18a893d7e0289208b4470bdfc75df8c6a893339cdf2cb68e

-- trigger trg_card_sync_observation_sets_guard_update on card_sync_observation_sets
-- guard: sha256 faf91f17243f457c0a0168e1417a1c74f826b39e8d1f55787f83e8750ae59b2e

-- trigger trg_card_sync_observation_sets_inv_delete on card_sync_observation_sets
CREATE TRIGGER trg_card_sync_observation_sets_inv_delete BEFORE DELETE ON card_sync_observation_sets
WHEN OLD.state NOT IN ('committed', 'rejected', 'expired-unreviewed')
BEGIN SELECT RAISE(ABORT, 'card invariant: only closed observation sets are deleted'); END;

-- trigger trg_card_sync_observation_sets_inv_frozen on card_sync_observation_sets
CREATE TRIGGER trg_card_sync_observation_sets_inv_frozen BEFORE UPDATE ON card_sync_observation_sets
WHEN NEW.id IS NOT OLD.id OR NEW.origin IS NOT OLD.origin OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.issuer IS NOT OLD.issuer OR NEW.currency IS NOT OLD.currency OR NEW.run_id IS NOT OLD.run_id OR NEW.device_id IS NOT OLD.device_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.capture_id IS NOT OLD.capture_id OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.contract_version IS NOT OLD.contract_version OR NEW.mode IS NOT OLD.mode OR NEW.observed_at IS NOT OLD.observed_at OR NEW.owner IS NOT OLD.owner OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.file_chunk IS NOT OLD.file_chunk OR NEW.source IS NOT OLD.source OR NEW.parser_version IS NOT OLD.parser_version OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.guard_revision IS NOT OLD.guard_revision OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.row_count IS NOT OLD.row_count OR NEW.byte_count IS NOT OLD.byte_count OR NEW.producer_rejected_count IS NOT OLD.producer_rejected_count OR NEW.statement_present IS NOT OLD.statement_present OR NEW.statement_charges_minor IS NOT OLD.statement_charges_minor OR NEW.statement_credits_minor IS NOT OLD.statement_credits_minor OR NEW.statement_net_minor IS NOT OLD.statement_net_minor OR NEW.statement_previous_balance_minor IS NOT OLD.statement_previous_balance_minor OR NEW.statement_new_balance_minor IS NOT OLD.statement_new_balance_minor
BEGIN SELECT RAISE(ABORT, 'card invariant: an observation set header is immutable'); END;

-- trigger trg_card_sync_observation_sets_inv_no_replace on card_sync_observation_sets
CREATE TRIGGER trg_card_sync_observation_sets_inv_no_replace BEFORE INSERT ON card_sync_observation_sets
WHEN EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.id = NEW.id AND x.origin = NEW.origin)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.capture_id = NEW.capture_id)
  OR EXISTS (SELECT 1 FROM card_sync_observation_sets x WHERE x.import_batch_id = NEW.import_batch_id AND x.file_chunk = NEW.file_chunk)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_observation_sets rows are never replaced'); END;

-- trigger trg_card_sync_observation_sets_inv_rowid on card_sync_observation_sets
CREATE TRIGGER trg_card_sync_observation_sets_inv_rowid BEFORE UPDATE ON card_sync_observation_sets
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.version IS NULL OR NEW.producer_rejected_count IS NULL OR NEW.statement_present IS NULL OR NEW.open_count IS NULL OR NEW.inserted_count IS NULL OR NEW.updated_count IS NULL OR NEW.matched_count IS NULL OR NEW.attributed_count IS NULL OR NEW.unchanged_count IS NULL OR NEW.rejected_count IS NULL OR NEW.expired_count IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_observation_sets rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_observation_sets_inv_state on card_sync_observation_sets
CREATE TRIGGER trg_card_sync_observation_sets_inv_state BEFORE UPDATE ON card_sync_observation_sets
BEGIN
  SELECT CASE
    WHEN NEW.review_ledger_revision < OLD.review_ledger_revision
      THEN RAISE(ABORT, 'card invariant: a review mark never goes back')
    WHEN NEW.version IS OLD.version AND (NEW.state IS NOT OLD.state OR NEW.open_count IS NOT OLD.open_count OR NEW.inserted_count IS NOT OLD.inserted_count OR NEW.updated_count IS NOT OLD.updated_count OR NEW.matched_count IS NOT OLD.matched_count OR NEW.attributed_count IS NOT OLD.attributed_count OR NEW.unchanged_count IS NOT OLD.unchanged_count OR NEW.rejected_count IS NOT OLD.rejected_count OR NEW.expired_count IS NOT OLD.expired_count OR NEW.receipt_state IS NOT OLD.receipt_state OR NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason OR NEW.discard_reason IS NOT OLD.discard_reason OR NEW.closed_by_ref IS NOT OLD.closed_by_ref OR NEW.content_purged_at IS NOT OLD.content_purged_at)
      THEN RAISE(ABORT, 'card invariant: an observation set version grows by one per change')
    WHEN NEW.version IS NOT OLD.version AND NEW.version IS NOT OLD.version + 1
      THEN RAISE(ABORT, 'card invariant: an observation set version grows by one per change')
    WHEN OLD.state IN ('committed', 'rejected', 'expired-unreviewed') AND (NEW.state IS NOT OLD.state OR NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason OR NEW.discard_reason IS NOT OLD.discard_reason OR NEW.closed_by_ref IS NOT OLD.closed_by_ref)
      THEN RAISE(ABORT, 'card invariant: a closed observation set never reopens')
    WHEN OLD.state IN ('rejected', 'expired-unreviewed') AND (NEW.open_count IS NOT OLD.open_count OR NEW.inserted_count IS NOT OLD.inserted_count OR NEW.updated_count IS NOT OLD.updated_count OR NEW.matched_count IS NOT OLD.matched_count OR NEW.attributed_count IS NOT OLD.attributed_count OR NEW.unchanged_count IS NOT OLD.unchanged_count OR NEW.rejected_count IS NOT OLD.rejected_count OR NEW.expired_count IS NOT OLD.expired_count)
      THEN RAISE(ABORT, 'card invariant: a discarded or expired observation set keeps its outcomes')
    WHEN OLD.content_purged_at IS NOT NULL AND NEW.content_purged_at IS NOT OLD.content_purged_at
      THEN RAISE(ABORT, 'card invariant: purged content stays purged')
    WHEN NEW.receipt_state IS NOT OLD.receipt_state AND NOT (OLD.receipt_state = 'kept' AND NEW.receipt_state IN ('expired', 'deleted'))
      THEN RAISE(ABORT, 'card invariant: a receipt only goes from kept to expired or deleted')
    WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL AND EXISTS (SELECT 1 FROM card_source_observations o WHERE o.observation_set_id = NEW.id AND o.state = 'open')
      THEN RAISE(ABORT, 'card invariant: an observation set closes only after its rows are settled')
    WHEN NEW.state IS NOT OLD.state AND NOT ((OLD.state = 'accepted-uncommitted' AND NEW.state IN ('needs-review', 'blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed')) OR (OLD.state = 'needs-review' AND NEW.state IN ('blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed')) OR (OLD.state = 'blocked-review' AND NEW.state IN ('recovery-review', 'committed', 'rejected', 'expired-unreviewed')) OR (OLD.state = 'recovery-review' AND NEW.state IN ('committed', 'rejected', 'expired-unreviewed')))
      THEN RAISE(ABORT, 'card invariant: observation set state change not allowed')
  END;
END;

-- trigger trg_card_sync_pairing_scopes_guard_insert on card_sync_pairing_scopes
-- guard: sha256 e38e27e1a366688b6191cbda948770346af901ce396dbd089ccc33682a55fd51

-- trigger trg_card_sync_pairing_scopes_guard_update on card_sync_pairing_scopes
-- guard: sha256 d16004768bfeef67a52fdeea10c3530f4bfc5719b829298c22a40d5f9ffcd249

-- trigger trg_card_sync_pairing_scopes_inv_delete on card_sync_pairing_scopes
CREATE TRIGGER trg_card_sync_pairing_scopes_inv_delete BEFORE DELETE ON card_sync_pairing_scopes
WHEN EXISTS (SELECT 1 FROM card_sync_pairings p WHERE p.id = OLD.pairing_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: pairing scopes are deleted only with their pairing'); END;

-- trigger trg_card_sync_pairing_scopes_inv_no_replace on card_sync_pairing_scopes
CREATE TRIGGER trg_card_sync_pairing_scopes_inv_no_replace BEFORE INSERT ON card_sync_pairing_scopes
WHEN EXISTS (SELECT 1 FROM card_sync_pairing_scopes x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_pairing_scopes x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_pairing_scopes x WHERE x.pairing_id = NEW.pairing_id AND x.binding_id = NEW.binding_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_pairing_scopes rows are never replaced'); END;

-- trigger trg_card_sync_pairing_scopes_inv_no_update on card_sync_pairing_scopes
CREATE TRIGGER trg_card_sync_pairing_scopes_inv_no_update BEFORE UPDATE ON card_sync_pairing_scopes
BEGIN SELECT RAISE(ABORT, 'card invariant: pairing scopes are frozen at pairing'); END;

-- trigger trg_card_sync_pairing_scopes_inv_open on card_sync_pairing_scopes
CREATE TRIGGER trg_card_sync_pairing_scopes_inv_open BEFORE INSERT ON card_sync_pairing_scopes
WHEN (SELECT p.status FROM card_sync_pairings p WHERE p.id = NEW.pairing_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'card invariant: a pairing chooses its bindings while it is open'); END;

-- trigger trg_card_sync_pairings_guard_insert on card_sync_pairings
-- guard: sha256 0b47d35d8fa8e4e2094d5cd00390c9f5281896238be8eda9db68a994ee1a52db

-- trigger trg_card_sync_pairings_guard_update on card_sync_pairings
-- guard: sha256 5f720bb46ad05cda5cb49c1b662b722e2b899170c252fe24352c6b16b4dcab8a

-- trigger trg_card_sync_pairings_inv_no_replace on card_sync_pairings
CREATE TRIGGER trg_card_sync_pairings_inv_no_replace BEFORE INSERT ON card_sync_pairings
WHEN EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.id = NEW.id)
  OR ((NEW.code_digest IS NOT NULL) AND EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.code_digest = NEW.code_digest AND x.code_digest IS NOT NULL))
  OR ((NEW.status = 'open') AND EXISTS (SELECT 1 FROM card_sync_pairings x WHERE x.created_by_ref = NEW.created_by_ref AND x.status = 'open'))
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_pairings rows are never replaced'); END;

-- trigger trg_card_sync_pairings_inv_rowid on card_sync_pairings
CREATE TRIGGER trg_card_sync_pairings_inv_rowid BEFORE UPDATE ON card_sync_pairings
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.status IS NULL OR NEW.failed_attempts IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_pairings rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_pairings_inv_update on card_sync_pairings
CREATE TRIGGER trg_card_sync_pairings_inv_update BEFORE UPDATE ON card_sync_pairings
BEGIN
  SELECT CASE
    WHEN OLD.status NOT IN ('open', 'redeemed')
      THEN RAISE(ABORT, 'card invariant: a closed pairing never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.created_by_ref IS NOT OLD.created_by_ref OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.replaces_device_id IS NOT OLD.replaces_device_id
      THEN RAISE(ABORT, 'card invariant: a pairing keeps its owner, lifetime and replacement target')
    WHEN NEW.code_digest IS NOT NULL AND NEW.code_digest IS NOT OLD.code_digest
      THEN RAISE(ABORT, 'card invariant: a pairing code is single-use and never replaced')
    WHEN NEW.failed_attempts < OLD.failed_attempts OR (OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS NOT OLD.redeemed_at)
      THEN RAISE(ABORT, 'card invariant: pairing history never goes back')
    WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'open' AND NEW.status IN ('redeemed', 'cancelled', 'expired', 'locked')) OR (OLD.status = 'redeemed' AND NEW.status IN ('approved', 'rejected', 'cancelled', 'expired')))
      THEN RAISE(ABORT, 'card invariant: pairing status change not allowed')
    WHEN NEW.redeemed_at IS NOT OLD.redeemed_at AND NOT (OLD.status = 'open' AND NEW.status = 'redeemed')
      THEN RAISE(ABORT, 'card invariant: a pairing records a redemption only when it is redeemed')
  END;
END;

-- trigger trg_card_sync_payload_receipts_guard_insert on card_sync_payload_receipts
-- guard: sha256 d8cebb6086d1768d0f0ec33bb9cc8fbdaf1827a47b53eccc306c16ad84c70e99

-- trigger trg_card_sync_payload_receipts_guard_update on card_sync_payload_receipts
-- guard: sha256 786cfb394a5cf8effe4c9a3f6272e79dfa05b49c1ba2a99f712052d8cb7c6c1d

-- trigger trg_card_sync_payload_receipts_inv_delete on card_sync_payload_receipts
CREATE TRIGGER trg_card_sync_payload_receipts_inv_delete BEFORE DELETE ON card_sync_payload_receipts
WHEN (SELECT s.receipt_state FROM card_sync_observation_sets s WHERE s.id = OLD.observation_set_id) IS 'kept'
BEGIN SELECT RAISE(ABORT, 'card invariant: a receipt is deleted only after its set gave it up'); END;

-- trigger trg_card_sync_payload_receipts_inv_kept on card_sync_payload_receipts
CREATE TRIGGER trg_card_sync_payload_receipts_inv_kept BEFORE INSERT ON card_sync_payload_receipts
WHEN (SELECT s.receipt_state FROM card_sync_observation_sets s WHERE s.id = NEW.observation_set_id) IS NOT 'kept'
BEGIN SELECT RAISE(ABORT, 'card invariant: a receipt is written only for a set that keeps one'); END;

-- trigger trg_card_sync_payload_receipts_inv_no_replace on card_sync_payload_receipts
CREATE TRIGGER trg_card_sync_payload_receipts_inv_no_replace BEFORE INSERT ON card_sync_payload_receipts
WHEN EXISTS (SELECT 1 FROM card_sync_payload_receipts x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_payload_receipts x WHERE x.observation_set_id = NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_payload_receipts rows are never replaced'); END;

-- trigger trg_card_sync_payload_receipts_inv_no_update on card_sync_payload_receipts
CREATE TRIGGER trg_card_sync_payload_receipts_inv_no_update BEFORE UPDATE ON card_sync_payload_receipts
BEGIN SELECT RAISE(ABORT, 'card invariant: a receipt holds the exact accepted bytes'); END;

-- trigger trg_card_sync_plan_actions_guard_insert on card_sync_plan_actions
-- guard: sha256 7789d812f91ee5edf5090fee8dd318f352957a9c701fa98414bf8a6422762548

-- trigger trg_card_sync_plan_actions_guard_update on card_sync_plan_actions
-- guard: sha256 408af6c7ffa4c7f5575038da1fbe0dccbe8362bee0d50efb5b2092be913a5e00

-- trigger trg_card_sync_plan_actions_inv_delete on card_sync_plan_actions
CREATE TRIGGER trg_card_sync_plan_actions_inv_delete BEFORE DELETE ON card_sync_plan_actions
WHEN EXISTS (SELECT 1 FROM card_sync_commit_plans p WHERE p.id = OLD.plan_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: plan actions are deleted only with their plan'); END;

-- trigger trg_card_sync_plan_actions_inv_no_replace on card_sync_plan_actions
CREATE TRIGGER trg_card_sync_plan_actions_inv_no_replace BEFORE INSERT ON card_sync_plan_actions
WHEN EXISTS (SELECT 1 FROM card_sync_plan_actions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_plan_actions x WHERE x.plan_id = NEW.plan_id AND x.ordinal = NEW.ordinal)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_plan_actions rows are never replaced'); END;

-- trigger trg_card_sync_plan_actions_inv_no_update on card_sync_plan_actions
CREATE TRIGGER trg_card_sync_plan_actions_inv_no_update BEFORE UPDATE ON card_sync_plan_actions
BEGIN SELECT RAISE(ABORT, 'card invariant: plan actions are frozen with their plan'); END;

-- trigger trg_card_sync_plan_actions_inv_prepared on card_sync_plan_actions
CREATE TRIGGER trg_card_sync_plan_actions_inv_prepared BEFORE INSERT ON card_sync_plan_actions
BEGIN
  SELECT CASE
    WHEN (SELECT p.status FROM card_sync_commit_plans p WHERE p.id = NEW.plan_id) IS NOT 'prepared'
      THEN RAISE(ABORT, 'card invariant: actions are written only into a prepared plan')
    WHEN NEW.ordinal >= (SELECT p.action_count FROM card_sync_commit_plans p WHERE p.id = NEW.plan_id)
      THEN RAISE(ABORT, 'card invariant: a plan holds only the actions it declares')
  END;
END;

-- trigger trg_card_sync_policy_guard_insert on card_sync_policy
-- guard: sha256 46a1509e770426937b397821b3d9abf78305ab07ff8d314ba086a49ed7426089

-- trigger trg_card_sync_policy_guard_update on card_sync_policy
-- guard: sha256 bfc02479a2e0d38b77abe9fad8b51ee356433a0af22e370fc363fa050f42d47b

-- trigger trg_card_sync_policy_inv_no_delete on card_sync_policy
CREATE TRIGGER trg_card_sync_policy_inv_no_delete BEFORE DELETE ON card_sync_policy
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_policy rows are never deleted'); END;

-- trigger trg_card_sync_policy_inv_no_replace on card_sync_policy
CREATE TRIGGER trg_card_sync_policy_inv_no_replace BEFORE INSERT ON card_sync_policy
WHEN EXISTS (SELECT 1 FROM card_sync_policy x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_policy x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_policy rows are never replaced'); END;

-- trigger trg_card_sync_policy_inv_rowid on card_sync_policy
CREATE TRIGGER trg_card_sync_policy_inv_rowid BEFORE UPDATE ON card_sync_policy
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.revision IS NULL OR NEW.paused IS NULL OR NEW.review_retention_days IS NULL OR NEW.receipt_retention_days IS NULL OR NEW.max_runs_per_device_day IS NULL OR NEW.quota_account_sets IS NULL OR NEW.quota_account_rows IS NULL OR NEW.quota_account_bytes IS NULL OR NEW.quota_device_sets IS NULL OR NEW.quota_device_rows IS NULL OR NEW.quota_device_bytes IS NULL OR NEW.quota_global_sets IS NULL OR NEW.quota_global_rows IS NULL OR NEW.quota_global_bytes IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_policy rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_policy_inv_update on card_sync_policy
CREATE TRIGGER trg_card_sync_policy_inv_update BEFORE UPDATE ON card_sync_policy
BEGIN
  SELECT CASE
    WHEN NEW.revision < OLD.revision OR NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'card invariant: the card sync policy revision never decreases')
  END;
END;

-- trigger trg_card_sync_runs_guard_insert on card_sync_runs
-- guard: sha256 a0a02cee2138f26dd366cd87bb865e6f12f19f829c4f49c251f63b8950fc6d46

-- trigger trg_card_sync_runs_guard_update on card_sync_runs
-- guard: sha256 60dc04aed95ec8c8d25ee93914ddd609cfade50fc4d3e4caf4d816021b84ffae

-- trigger trg_card_sync_runs_inv_no_replace on card_sync_runs
CREATE TRIGGER trg_card_sync_runs_inv_no_replace BEFORE INSERT ON card_sync_runs
WHEN EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.device_id = NEW.device_id AND x.client_run_id = NEW.client_run_id)
  OR EXISTS (SELECT 1 FROM card_sync_runs x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_runs rows are never replaced'); END;

-- trigger trg_card_sync_runs_inv_rowid on card_sync_runs
CREATE TRIGGER trg_card_sync_runs_inv_rowid BEFORE UPDATE ON card_sync_runs
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.acceptance_state IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_runs rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_sync_runs_inv_update on card_sync_runs
CREATE TRIGGER trg_card_sync_runs_inv_update BEFORE UPDATE ON card_sync_runs
BEGIN
  SELECT CASE
    WHEN OLD.acceptance_state IN ('refused', 'expired', 'aborted')
      THEN RAISE(ABORT, 'card invariant: a closed run never changes')
    WHEN NEW.id IS NOT OLD.id OR NEW.device_id IS NOT OLD.device_id OR NEW.client_run_id IS NOT OLD.client_run_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.adapter_version IS NOT OLD.adapter_version OR NEW.contract_version IS NOT OLD.contract_version OR NEW.run_trigger IS NOT OLD.run_trigger OR NEW.authorization_generation IS NOT OLD.authorization_generation OR NEW.created_at IS NOT OLD.created_at OR NEW.upload_expires_at IS NOT OLD.upload_expires_at
      THEN RAISE(ABORT, 'card invariant: a run keeps its device, binding and window')
    WHEN OLD.acceptance_state = 'accepted' AND (NEW.acceptance_state IS NOT OLD.acceptance_state OR NEW.payload_digest IS NOT OLD.payload_digest OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.closed_at IS NOT OLD.closed_at OR NEW.refusal_code IS NOT OLD.refusal_code OR (OLD.aborted_at IS NOT NULL AND (NEW.aborted_at IS NOT OLD.aborted_at OR NEW.abort_reason IS NOT OLD.abort_reason)))
      THEN RAISE(ABORT, 'card invariant: an accepted run keeps its acceptance')
  END;
END;

-- trigger trg_card_sync_set_card_hints_guard_insert on card_sync_set_card_hints
-- guard: sha256 4b4e721be296623c503d1b1d330187038605ae2b9809550df26e25e618de6d33

-- trigger trg_card_sync_set_card_hints_guard_update on card_sync_set_card_hints
-- guard: sha256 7a6d6313f726cda9a7da4ff9d5ae5951dff62f7c681b2f5dda9bba7c9a0b6b82

-- trigger trg_card_sync_set_card_hints_inv_delete on card_sync_set_card_hints
CREATE TRIGGER trg_card_sync_set_card_hints_inv_delete BEFORE DELETE ON card_sync_set_card_hints
WHEN EXISTS (SELECT 1 FROM card_sync_observation_sets s WHERE s.id = OLD.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card hints are deleted only with their set'); END;

-- trigger trg_card_sync_set_card_hints_inv_no_replace on card_sync_set_card_hints
CREATE TRIGGER trg_card_sync_set_card_hints_inv_no_replace BEFORE INSERT ON card_sync_set_card_hints
WHEN EXISTS (SELECT 1 FROM card_sync_set_card_hints x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_set_card_hints x WHERE x.observation_set_id = NEW.observation_set_id AND x.ordinal = NEW.ordinal)
  OR EXISTS (SELECT 1 FROM card_sync_set_card_hints x WHERE x.observation_set_id = NEW.observation_set_id AND x.last4 = NEW.last4)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_set_card_hints rows are never replaced'); END;

-- trigger trg_card_sync_set_card_hints_inv_no_update on card_sync_set_card_hints
CREATE TRIGGER trg_card_sync_set_card_hints_inv_no_update BEFORE UPDATE ON card_sync_set_card_hints
BEGIN SELECT RAISE(ABORT, 'card invariant: card hints are frozen at acceptance'); END;

-- trigger trg_card_sync_set_card_hints_inv_order on card_sync_set_card_hints
CREATE TRIGGER trg_card_sync_set_card_hints_inv_order BEFORE INSERT ON card_sync_set_card_hints
WHEN NEW.ordinal IS NOT (SELECT count(*) FROM card_sync_set_card_hints h WHERE h.observation_set_id = NEW.observation_set_id) OR NEW.last4 <= (SELECT max(h.last4) FROM card_sync_set_card_hints h WHERE h.observation_set_id = NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card hints are sorted, unique and dense'); END;

-- trigger trg_card_sync_sources_guard_insert on card_sync_sources
-- guard: sha256 b8aeb4bfc35408dee1a419f49d1b28aa17135e75c25f234c5b88006ddac6be7a

-- trigger trg_card_sync_sources_guard_update on card_sync_sources
-- guard: sha256 4362ff9f0c8a5a89d8834c322c07ecdbcd16d8970d930d0f0c6b9d4aacc4e8fc

-- trigger trg_card_sync_sources_inv_no_delete on card_sync_sources
CREATE TRIGGER trg_card_sync_sources_inv_no_delete BEFORE DELETE ON card_sync_sources
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are never deleted'); END;

-- trigger trg_card_sync_sources_inv_no_replace on card_sync_sources
CREATE TRIGGER trg_card_sync_sources_inv_no_replace BEFORE INSERT ON card_sync_sources
WHEN EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.source = NEW.source)
  OR EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.source = NEW.source AND x.issuer = NEW.issuer)
  OR EXISTS (SELECT 1 FROM card_sync_sources x WHERE x.source = NEW.source AND x.issuer = NEW.issuer AND x.mode = NEW.mode)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_sync_sources rows are never replaced'); END;

-- trigger trg_card_sync_sources_inv_no_update on card_sync_sources
CREATE TRIGGER trg_card_sync_sources_inv_no_update BEFORE UPDATE ON card_sync_sources
BEGIN SELECT RAISE(ABORT, 'card invariant: registry rows are immutable'); END;

-- trigger trg_card_transaction_events_guard_insert on card_transaction_events
-- guard: sha256 8bafdd5e6636210674ff04106610a58cd8944feceb6cb9fa5621e3e1d63b9199

-- trigger trg_card_transaction_events_guard_update on card_transaction_events
-- guard: sha256 a23a026fba27472511226be093b0a59f854e5f437c649e24b04b16b7d748cc7c

-- trigger trg_card_transaction_events_inv_no_delete on card_transaction_events
CREATE TRIGGER trg_card_transaction_events_inv_no_delete BEFORE DELETE ON card_transaction_events
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_events rows are never deleted'); END;

-- trigger trg_card_transaction_events_inv_no_replace on card_transaction_events
CREATE TRIGGER trg_card_transaction_events_inv_no_replace BEFORE INSERT ON card_transaction_events
WHEN EXISTS (SELECT 1 FROM card_transaction_events x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_transaction_events x WHERE x.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_events rows are never replaced'); END;

-- trigger trg_card_transaction_events_inv_no_update on card_transaction_events
CREATE TRIGGER trg_card_transaction_events_inv_no_update BEFORE UPDATE ON card_transaction_events
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_events rows are append-only'); END;

-- trigger trg_card_transaction_versions_guard_insert on card_transaction_versions
-- guard: sha256 e96ce4a43f17e835b8d90aa0636e903d962eacb51710188f653c3a289835d0cc

-- trigger trg_card_transaction_versions_guard_update on card_transaction_versions
-- guard: sha256 42e2ca0c9c6cfd64c98778f12265dd27f92fc194c79c1251755b1a56d6f80b57

-- trigger trg_card_transaction_versions_inv_authentic on card_transaction_versions
CREATE TRIGGER trg_card_transaction_versions_inv_authentic BEFORE INSERT ON card_transaction_versions
WHEN NOT EXISTS (SELECT 1 FROM card_transactions t WHERE t.id = NEW.card_transaction_id AND t.revision = NEW.revision AND t.card_account_id = NEW.card_account_id AND t.status IS NEW.status AND t.transaction_date IS NEW.transaction_date AND t.posted_date IS NEW.posted_date AND t.amount_minor IS NEW.amount_minor AND t.original_amount_minor IS NEW.original_amount_minor AND t.original_currency IS NEW.original_currency AND t.kind IS NEW.kind AND t.description IS NEW.description AND t.merchant IS NEW.merchant AND t.issuer_category IS NEW.issuer_category AND t.card_scope_id IS NEW.card_scope_id AND t.removed_reason IS NEW.removed_reason AND t.removed_from_status IS NEW.removed_from_status AND t.removed_at IS NEW.removed_at AND t.merged_into_id IS NEW.merged_into_id AND t.dismissed_at IS NEW.dismissed_at AND t.reversal_snapshot_revision IS NEW.reversal_snapshot_revision)
BEGIN SELECT RAISE(ABORT, 'card invariant: a snapshot records a card transaction as it is'); END;

-- trigger trg_card_transaction_versions_inv_no_delete on card_transaction_versions
CREATE TRIGGER trg_card_transaction_versions_inv_no_delete BEFORE DELETE ON card_transaction_versions
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_versions rows are never deleted'); END;

-- trigger trg_card_transaction_versions_inv_no_replace on card_transaction_versions
CREATE TRIGGER trg_card_transaction_versions_inv_no_replace BEFORE INSERT ON card_transaction_versions
WHEN EXISTS (SELECT 1 FROM card_transaction_versions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_transaction_versions x WHERE x.card_transaction_id = NEW.card_transaction_id AND x.revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_versions rows are never replaced'); END;

-- trigger trg_card_transaction_versions_inv_no_update on card_transaction_versions
CREATE TRIGGER trg_card_transaction_versions_inv_no_update BEFORE UPDATE ON card_transaction_versions
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transaction_versions rows are append-only'); END;

-- trigger trg_card_transactions_guard_insert on card_transactions
-- guard: sha256 48889694ab77c055d81c15e092cf2cc23c29d9fcea8702c99cf1207214db4a4e

-- trigger trg_card_transactions_guard_update on card_transactions
-- guard: sha256 ad68728fb2fb820d5fcccb92fa20f3fea77d0f5f65542f595612cd1b5401a244

-- trigger trg_card_transactions_inv_insert on card_transactions
CREATE TRIGGER trg_card_transactions_inv_insert BEFORE INSERT ON card_transactions
WHEN NEW.status NOT IN ('pending', 'posted') OR NEW.revision IS NOT 1 OR NEW.reversal_snapshot_revision IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: a card transaction starts pending or posted at revision 1'); END;

-- trigger trg_card_transactions_inv_no_delete on card_transactions
CREATE TRIGGER trg_card_transactions_inv_no_delete BEFORE DELETE ON card_transactions
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transactions rows are never deleted'); END;

-- trigger trg_card_transactions_inv_no_replace on card_transactions
CREATE TRIGGER trg_card_transactions_inv_no_replace BEFORE INSERT ON card_transactions
WHEN EXISTS (SELECT 1 FROM card_transactions x WHERE x.rowid = NEW.rowid)
  OR EXISTS (SELECT 1 FROM card_transactions x WHERE x.id = NEW.id)
  OR EXISTS (SELECT 1 FROM card_transactions x WHERE x.id = NEW.id AND x.card_account_id = NEW.card_account_id)
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transactions rows are never replaced'); END;

-- trigger trg_card_transactions_inv_rowid on card_transactions
CREATE TRIGGER trg_card_transactions_inv_rowid BEFORE UPDATE ON card_transactions
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.created_at IS NULL OR NEW.updated_at IS NULL OR NEW.revision IS NULL
BEGIN SELECT RAISE(ABORT, 'card invariant: card_transactions rows keep their rowid and never fall back to a default'); END;

-- trigger trg_card_transactions_inv_snapshot on card_transactions
CREATE TRIGGER trg_card_transactions_inv_snapshot BEFORE UPDATE ON card_transactions
WHEN NEW.status IS NOT OLD.status OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at
BEGIN
  INSERT INTO card_transaction_versions (card_transaction_id, revision, card_account_id, status, transaction_date, posted_date, amount_minor, original_amount_minor, original_currency, kind, description, merchant, issuer_category, card_scope_id, removed_reason, removed_from_status, removed_at, merged_into_id, dismissed_at, reversal_snapshot_revision, replaced_at)
  SELECT OLD.id, OLD.revision, OLD.card_account_id, OLD.status, OLD.transaction_date, OLD.posted_date, OLD.amount_minor, OLD.original_amount_minor, OLD.original_currency, OLD.kind, OLD.description, OLD.merchant, OLD.issuer_category, OLD.card_scope_id, OLD.removed_reason, OLD.removed_from_status, OLD.removed_at, OLD.merged_into_id, OLD.dismissed_at, OLD.reversal_snapshot_revision, NEW.updated_at
  WHERE NOT EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.revision);
END;

-- trigger trg_card_transactions_inv_update on card_transactions
CREATE TRIGGER trg_card_transactions_inv_update BEFORE UPDATE ON card_transactions
BEGIN
  SELECT CASE
    WHEN NEW.revision IS NOT OLD.revision + 1
      THEN RAISE(ABORT, 'card invariant: a card transaction revision grows by one per update')
    WHEN NEW.id IS NOT OLD.id OR NEW.card_account_id IS NOT OLD.card_account_id OR NEW.currency IS NOT OLD.currency OR NEW.source IS NOT OLD.source OR NEW.external_id_hash IS NOT OLD.external_id_hash OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.import_batch_id IS NOT OLD.import_batch_id OR NEW.first_sync_run_id IS NOT OLD.first_sync_run_id OR NEW.created_at IS NOT OLD.created_at
      THEN RAISE(ABORT, 'card invariant: a card transaction keeps its provenance')
    WHEN OLD.status = 'removed' AND NEW.status = 'removed' AND (NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at)
      THEN RAISE(ABORT, 'card invariant: removal history is frozen while removed')
    WHEN NEW.removed_reason IS 'legacy' AND OLD.removed_reason IS NOT 'legacy' AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: the legacy removal reason is never assigned')
    WHEN OLD.status IN ('pending', 'posted') AND NEW.status = 'removed' AND NEW.removed_from_status IS NOT OLD.status AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: a removal records the status it removed')
    WHEN OLD.status = 'removed' AND NEW.status = 'pending' AND OLD.removed_from_status IS NOT 'pending' AND OLD.removed_reason IS NOT 'legacy'
      THEN RAISE(ABORT, 'card invariant: a removed card transaction returns only to its prior status')
    WHEN OLD.status = 'posted' AND NEW.status = 'pending' AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: a posted card transaction never returns to pending')
    WHEN NEW.reversal_snapshot_revision IS NOT NULL AND NEW.reversal_snapshot_revision IS NOT OLD.reversal_snapshot_revision AND NOT (OLD.reversal_snapshot_revision IS NOT NULL AND EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = OLD.id AND v.revision = OLD.reversal_snapshot_revision AND v.reversal_snapshot_revision IS NEW.reversal_snapshot_revision AND v.status IS NEW.status AND v.transaction_date IS NEW.transaction_date AND v.posted_date IS NEW.posted_date AND v.amount_minor IS NEW.amount_minor AND v.kind IS NEW.kind AND v.description IS NEW.description AND v.merchant IS NEW.merchant AND v.issuer_category IS NEW.issuer_category AND v.original_amount_minor IS NEW.original_amount_minor AND v.original_currency IS NEW.original_currency AND v.card_scope_id IS NEW.card_scope_id AND v.removed_reason IS NEW.removed_reason AND v.removed_from_status IS NEW.removed_from_status AND v.removed_at IS NEW.removed_at AND v.merged_into_id IS NEW.merged_into_id AND v.dismissed_at IS NEW.dismissed_at)) AND (NEW.reversal_snapshot_revision IS NOT OLD.revision OR NOT (NEW.status IS NOT OLD.status OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at))
      THEN RAISE(ABORT, 'card invariant: a reversal marker names the change that set it')
    WHEN NEW.reversal_snapshot_revision IS NOT NULL AND NEW.reversal_snapshot_revision IS OLD.reversal_snapshot_revision AND (NEW.status IS NOT OLD.status OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description OR NEW.merchant IS NOT OLD.merchant OR NEW.issuer_category IS NOT OLD.issuer_category OR NEW.original_amount_minor IS NOT OLD.original_amount_minor OR NEW.original_currency IS NOT OLD.original_currency OR NEW.card_scope_id IS NOT OLD.card_scope_id OR NEW.removed_reason IS NOT OLD.removed_reason OR NEW.removed_from_status IS NOT OLD.removed_from_status OR NEW.removed_at IS NOT OLD.removed_at OR NEW.merged_into_id IS NOT OLD.merged_into_id OR NEW.dismissed_at IS NOT OLD.dismissed_at)
      THEN RAISE(ABORT, 'card invariant: a value change replaces or clears the reversal marker')
    WHEN NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS NOT OLD.merged_into_id AND (SELECT t.status FROM card_transactions t WHERE t.id = NEW.merged_into_id) IS NOT 'posted' AND (SELECT t.status FROM card_transactions t WHERE t.id = NEW.merged_into_id) IS NOT 'pending'
      THEN RAISE(ABORT, 'card invariant: a card transaction merges only into a live one')
    WHEN NEW.removed_reason IN ('superseded', 'settled-into') AND NEW.removed_reason IS NOT OLD.removed_reason AND EXISTS (SELECT 1 FROM card_source_identities i WHERE i.canonical_transaction_id = NEW.id AND i.status = 'active')
      THEN RAISE(ABORT, 'card invariant: re-point identities before merging a card transaction')
  END;
END;

-- card_accounts: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|0|NULL|1|0
--   1|issuer|TEXT|1|NULL|0|0
--   2|owner|TEXT|1|NULL|0|0
--   3|nickname|TEXT|0|NULL|0|0
--   4|last4|TEXT|0|NULL|0|0
--   5|currency|TEXT|1|NULL|0|0
--   6|status|TEXT|1|'active'|0|0
--   7|created_at|TEXT|1|strftime('%Y-%m-%dT%H:%M:%fZ', 'now')|0|0
--   8|updated_at|TEXT|1|strftime('%Y-%m-%dT%H:%M:%fZ', 'now')|0|0
--   9|last5|TEXT|0|NULL|0|0
--   10|ledger_revision|INTEGER|1|0|0|0
-- card_accounts: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
-- card_accounts: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_accounts_fk_currency|1|c|0
--     0|0|id|0|BINARY|1
--     1|5|currency|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_accounts_fk_issuer_currency|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|issuer|0|BINARY|1
--     2|5|currency|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_accounts_identity|0|c|0
--     0|1|issuer|0|BINARY|1
--     1|2|owner|0|BINARY|1
--     2|4|last4|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_accounts_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_coverage_windows: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|card_scope_id|TEXT|1|NULL|0|0
--   3|source_kind|TEXT|1|NULL|0|0
--   4|source|TEXT|1|NULL|0|0
--   5|import_batch_id|TEXT|0|NULL|0|0
--   6|observation_set_id|TEXT|0|NULL|0|0
--   7|entry_ordinal|INTEGER|0|NULL|0|0
--   8|status|TEXT|1|NULL|0|0
--   9|requested_start|TEXT|0|NULL|0|0
--   10|requested_end|TEXT|0|NULL|0|0
--   11|requested_basis|TEXT|0|NULL|0|0
--   12|observed_start|TEXT|0|NULL|0|0
--   13|observed_end|TEXT|0|NULL|0|0
--   14|observed_basis|TEXT|0|NULL|0|0
--   15|claimed_completeness|TEXT|1|NULL|0|0
--   16|verified_completeness|TEXT|1|NULL|0|0
--   17|termination|TEXT|0|NULL|0|0
--   18|page_count|INTEGER|0|NULL|0|0
--   19|evidence|TEXT|1|NULL|0|0
--   20|ledger_state|TEXT|1|NULL|0|0
--   21|observed_at|TEXT|0|NULL|0|0
--   22|recorded_at|TEXT|1|NULL|0|0
--   23|updated_at|TEXT|1|NULL|0|0
-- card_coverage_windows: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_sync_observation_sets|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_import_batches|import_batch_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_import_batches|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_scopes|card_scope_id|id|NO ACTION|RESTRICT|NONE
--   2|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
-- card_coverage_windows: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_coverage_windows_batch|1|c|0
--     0|5|import_batch_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_coverage_windows_scope|0|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|2|card_scope_id|0|BINARY|1
--     2|8|status|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_coverage_windows_set_entry|1|c|0
--     0|6|observation_set_id|0|BINARY|1
--     1|7|entry_ordinal|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_coverage_windows_set_scope|1|c|1
--     0|6|observation_set_id|0|BINARY|1
--     1|2|card_scope_id|0|BINARY|1
--     2|8|status|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_coverage_windows_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_identity_contents: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|identity_id|TEXT|1|NULL|1|0
--   1|content_digest|TEXT|1|NULL|2|0
--   2|resolution|TEXT|1|NULL|0|0
--   3|recorded_at|TEXT|1|NULL|0|0
-- card_identity_contents: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_source_identities|identity_id|id|NO ACTION|RESTRICT|NONE
-- card_identity_contents: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   sqlite_autoindex_card_identity_contents_1|1|pk|0
--     0|0|identity_id|0|BINARY|1
--     1|1|content_digest|0|BINARY|1
--     2|-1|NULL|0|BINARY|0

-- card_import_batches: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|0|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|source|TEXT|1|NULL|0|0
--   3|parser_version|TEXT|1|NULL|0|0
--   4|row_count|INTEGER|1|NULL|0|0
--   5|new_count|INTEGER|1|NULL|0|0
--   6|duplicate_count|INTEGER|1|NULL|0|0
--   7|rejected_count|INTEGER|1|NULL|0|0
--   8|imported_at|TEXT|1|strftime('%Y-%m-%dT%H:%M:%fZ', 'now')|0|0
--   9|coverage_start|TEXT|0|NULL|0|0
--   10|coverage_end|TEXT|0|NULL|0|0
-- card_import_batches: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
-- card_import_batches: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_import_batches_account|0|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|8|imported_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_import_batches_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_import_batches_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_observation_secondary_ids: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|observation_id|TEXT|1|NULL|0|0
--   2|ordinal|INTEGER|1|NULL|0|0
--   3|namespace|TEXT|1|NULL|0|0
--   4|namespace_kind|TEXT|1|NULL|0|0
--   5|id_hash|TEXT|1|NULL|0|0
-- card_observation_secondary_ids: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_namespaces|namespace|namespace|NO ACTION|RESTRICT|NONE
--   0|1|card_sync_namespaces|namespace_kind|kind|NO ACTION|RESTRICT|NONE
--   1|0|card_source_observations|observation_id|id|NO ACTION|CASCADE|NONE
-- card_observation_secondary_ids: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_observation_secondary_ids_namespace|1|c|0
--     0|1|observation_id|0|BINARY|1
--     1|3|namespace|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_observation_secondary_ids_ordinal|1|c|0
--     0|1|observation_id|0|BINARY|1
--     1|2|ordinal|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_observation_secondary_ids_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_payment_links: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|card_transaction_id|TEXT|1|NULL|0|0
--   2|cash_event_ref|TEXT|1|NULL|0|0
--   3|decision|TEXT|1|NULL|0|0
--   4|amount_minor|INTEGER|1|NULL|0|0
--   5|currency|TEXT|1|NULL|0|0
--   6|rules_version|INTEGER|1|NULL|0|0
--   7|decided_at|TEXT|1|NULL|0|0
--   8|decided_by_ref|TEXT|0|NULL|0|0
-- card_payment_links: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_transactions|card_transaction_id|id|NO ACTION|RESTRICT|NONE
-- card_payment_links: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_payment_links_confirmed_payment|1|c|1
--     0|1|card_transaction_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_payment_links_confirmed_source|1|c|1
--     0|2|cash_event_ref|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_payment_links_pair|1|c|0
--     0|1|card_transaction_id|0|BINARY|1
--     1|2|cash_event_ref|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_payment_links_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_reconciliation_candidates: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|review_item_id|TEXT|1|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|rank|INTEGER|1|NULL|2|0
--   3|transaction_id|TEXT|1|NULL|0|0
--   4|rule|TEXT|1|NULL|0|0
--   5|matched_on|INTEGER|1|NULL|0|0
--   6|blocked_reason|TEXT|0|NULL|0|0
-- card_reconciliation_candidates: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_transactions|transaction_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_reconciliation_suggestions|review_item_id|id|NO ACTION|CASCADE|NONE
--   1|1|card_reconciliation_suggestions|card_account_id|card_account_id|NO ACTION|CASCADE|NONE
-- card_reconciliation_candidates: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_reconciliation_candidates_target|1|c|0
--     0|0|review_item_id|0|BINARY|1
--     1|3|transaction_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_reconciliation_candidates_transaction|0|c|0
--     0|3|transaction_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_reconciliation_candidates_1|1|pk|0
--     0|0|review_item_id|0|BINARY|1
--     1|2|rank|0|BINARY|1
--     2|-1|NULL|0|BINARY|0

-- card_reconciliation_suggestions: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|observation_set_id|TEXT|1|NULL|0|0
--   2|card_account_id|TEXT|1|NULL|0|0
--   3|observation_id|TEXT|0|NULL|0|0
--   4|category|TEXT|1|NULL|0|0
--   5|reason|TEXT|1|NULL|0|0
--   6|allowed_actions|INTEGER|1|NULL|0|0
--   7|difference_field|TEXT|0|NULL|0|0
--   8|expected_minor|INTEGER|0|NULL|0|0
--   9|actual_minor|INTEGER|0|NULL|0|0
--   10|status|TEXT|1|'open'|0|0
--   11|draft_action|TEXT|0|NULL|0|0
--   12|draft_transaction_id|TEXT|0|NULL|0|0
--   13|draft_scope_id|TEXT|0|NULL|0|0
--   14|drafted_by_ref|TEXT|0|NULL|0|0
--   15|drafted_at|TEXT|0|NULL|0|0
--   16|committed_action|TEXT|0|NULL|0|0
--   17|committed_transaction_id|TEXT|0|NULL|0|0
--   18|committed_scope_id|TEXT|0|NULL|0|0
--   19|committed_revision|INTEGER|0|NULL|0|0
--   20|committed_plan_id|TEXT|0|NULL|0|0
--   21|committed_at|TEXT|0|NULL|0|0
--   22|classified_ledger_revision|INTEGER|1|NULL|0|0
--   23|created_at|TEXT|1|NULL|0|0
--   24|updated_at|TEXT|1|NULL|0|0
-- card_reconciliation_suggestions: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_scopes|committed_scope_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_scopes|draft_scope_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_transactions|committed_transaction_id|id|NO ACTION|RESTRICT|NONE
--   2|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   3|0|card_reconciliation_candidates|id|review_item_id|NO ACTION|RESTRICT|NONE
--   3|1|card_reconciliation_candidates|draft_transaction_id|transaction_id|NO ACTION|RESTRICT|NONE
--   4|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
--   4|1|card_sync_observation_sets|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   5|0|card_source_observations|observation_id|id|NO ACTION|CASCADE|NONE
-- card_reconciliation_suggestions: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_reconciliation_suggestions_committed|0|c|0
--     0|17|committed_transaction_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_reconciliation_suggestions_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|2|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_reconciliation_suggestions_observation|1|c|0
--     0|3|observation_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_reconciliation_suggestions_set|0|c|0
--     0|1|observation_set_id|0|BINARY|1
--     1|10|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_reconciliation_suggestions_set_level|1|c|1
--     0|1|observation_set_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_reconciliation_suggestions_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_scopes: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|kind|TEXT|1|NULL|0|0
--   3|holder_alias|TEXT|1|NULL|0|0
--   4|last4|TEXT|0|NULL|0|0
--   5|label|TEXT|1|NULL|0|0
--   6|status|TEXT|1|'active'|0|0
--   7|version|INTEGER|1|1|0|0
--   8|confirmed_by_ref|TEXT|0|NULL|0|0
--   9|confirmed_at|TEXT|0|NULL|0|0
--   10|retired_at|TEXT|0|NULL|0|0
--   11|created_at|TEXT|1|NULL|0|0
--   12|updated_at|TEXT|1|NULL|0|0
-- card_scopes: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
-- card_scopes: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_scopes_account|0|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|2|kind|0|BINARY|1
--     2|6|status|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_scopes_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_scopes_fk_kind|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|card_account_id|0|BINARY|1
--     2|2|kind|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_scopes_one_legacy|1|c|1
--     0|1|card_account_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_scopes_one_unknown|1|c|1
--     0|1|card_account_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_scopes_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_source_binding_scopes: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|binding_id|TEXT|1|NULL|0|0
--   2|card_scope_id|TEXT|1|NULL|0|0
--   3|card_account_id|TEXT|1|NULL|0|0
--   4|card_scope_kind|TEXT|1|NULL|0|0
--   5|binding_version|INTEGER|1|NULL|0|0
--   6|status|TEXT|1|'active'|0|0
--   7|created_at|TEXT|1|NULL|0|0
--   8|revoked_at|TEXT|0|NULL|0|0
-- card_source_binding_scopes: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_scopes|card_scope_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   0|2|card_scopes|card_scope_kind|kind|NO ACTION|RESTRICT|NONE
--   1|0|card_source_bindings|binding_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_source_bindings|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
-- card_source_binding_scopes: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_source_binding_scopes_active|1|c|1
--     0|1|binding_id|0|BINARY|1
--     1|2|card_scope_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_binding_scopes_binding|0|c|0
--     0|1|binding_id|0|BINARY|1
--     1|6|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_binding_scopes_scope|0|c|0
--     0|2|card_scope_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_source_binding_scopes_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_source_bindings: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|issuer|TEXT|1|NULL|0|0
--   3|currency|TEXT|1|NULL|0|0
--   4|source|TEXT|1|NULL|0|0
--   5|source_account_digest|TEXT|0|NULL|0|0
--   6|label|TEXT|1|NULL|0|0
--   7|status|TEXT|1|'confirmed'|0|0
--   8|status_reason|TEXT|0|NULL|0|0
--   9|version|INTEGER|1|1|0|0
--   10|auto_sync_revision|INTEGER|1|1|0|0
--   11|confirmed_by_ref|TEXT|1|NULL|0|0
--   12|confirmed_at|TEXT|1|NULL|0|0
--   13|retired_at|TEXT|0|NULL|0|0
--   14|created_at|TEXT|1|NULL|0|0
--   15|updated_at|TEXT|1|NULL|0|0
-- card_source_bindings: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_sources|source|source|NO ACTION|RESTRICT|NONE
--   0|1|card_sync_sources|issuer|issuer|NO ACTION|RESTRICT|NONE
--   1|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_accounts|issuer|issuer|NO ACTION|RESTRICT|NONE
--   1|2|card_accounts|currency|currency|NO ACTION|RESTRICT|NONE
-- card_source_bindings: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_source_bindings_account|0|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|7|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_bindings_digest|1|c|1
--     0|4|source|0|BINARY|1
--     1|5|source_account_digest|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_bindings_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_bindings_fk_source|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|card_account_id|0|BINARY|1
--     2|4|source|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_source_bindings_live|1|c|1
--     0|1|card_account_id|0|BINARY|1
--     1|4|source|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_source_bindings_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_source_identities: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|source_scope_id|TEXT|1|NULL|0|0
--   3|source_scope_kind|TEXT|1|NULL|0|0
--   4|namespace|TEXT|1|NULL|0|0
--   5|namespace_kind|TEXT|1|NULL|0|0
--   6|id_hash|TEXT|1|NULL|0|0
--   7|canonical_transaction_id|TEXT|1|NULL|0|0
--   8|status|TEXT|1|'active'|0|0
--   9|first_seen_status|TEXT|1|NULL|0|0
--   10|created_origin|TEXT|1|NULL|0|0
--   11|import_batch_id|TEXT|0|NULL|0|0
--   12|first_observation_id|TEXT|0|NULL|0|0
--   13|created_at|TEXT|1|NULL|0|0
--   14|last_seen_at|TEXT|0|NULL|0|0
--   15|last_seen_run_id|TEXT|0|NULL|0|0
-- card_source_identities: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_import_batches|import_batch_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_import_batches|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_transactions|canonical_transaction_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_sync_namespaces|namespace|namespace|NO ACTION|RESTRICT|NONE
--   2|1|card_sync_namespaces|namespace_kind|kind|NO ACTION|RESTRICT|NONE
--   3|0|card_scopes|source_scope_id|id|NO ACTION|RESTRICT|NONE
--   3|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   3|2|card_scopes|source_scope_kind|kind|NO ACTION|RESTRICT|NONE
--   4|0|card_sync_runs|last_seen_run_id|id|NO ACTION|RESTRICT|NONE
--   5|0|card_source_observations|first_observation_id|id|NO ACTION|RESTRICT|NONE
-- card_source_identities: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_source_identities_canonical|0|c|0
--     0|7|canonical_transaction_id|0|BINARY|1
--     1|8|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_identities_first_observation|0|c|0
--     0|12|first_observation_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_source_identities_last_seen_run|0|c|0
--     0|15|last_seen_run_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_source_identities_page|0|c|0
--     0|7|canonical_transaction_id|0|BINARY|1
--     1|13|created_at|0|BINARY|1
--     2|0|id|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_source_identities_tuple|1|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|2|source_scope_id|0|BINARY|1
--     2|4|namespace|0|BINARY|1
--     3|6|id_hash|0|BINARY|1
--     4|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_source_identities_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_source_observations: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|observation_set_id|TEXT|1|NULL|0|0
--   2|origin|TEXT|1|NULL|0|0
--   3|card_account_id|TEXT|1|NULL|0|0
--   4|ordinal|INTEGER|1|NULL|0|0
--   5|file_row_index|INTEGER|0|NULL|0|0
--   6|source_scope_id|TEXT|1|NULL|0|0
--   7|source_scope_kind|TEXT|1|NULL|0|0
--   8|identity_namespace|TEXT|1|NULL|0|0
--   9|namespace_kind|TEXT|1|NULL|0|0
--   10|external_id_hash|TEXT|0|NULL|0|0
--   11|fingerprint|TEXT|0|NULL|0|0
--   12|identity_hash|TEXT|1|NULL|0|0
--   13|transaction_date|TEXT|1|NULL|0|0
--   14|posted_date|TEXT|0|NULL|0|0
--   15|status|TEXT|1|NULL|0|0
--   16|amount_minor|INTEGER|1|NULL|0|0
--   17|currency|TEXT|1|NULL|0|0
--   18|original_amount_minor|INTEGER|0|NULL|0|0
--   19|original_currency|TEXT|0|NULL|0|0
--   20|kind|TEXT|1|NULL|0|0
--   21|description|TEXT|1|NULL|0|0
--   22|merchant|TEXT|0|NULL|0|0
--   23|issuer_category|TEXT|0|NULL|0|0
--   24|content_digest|TEXT|1|NULL|0|0
--   25|state|TEXT|1|'open'|0|0
--   26|outcome|TEXT|0|NULL|0|0
--   27|resolved_transaction_id|TEXT|0|NULL|0|0
--   28|provenance|INTEGER|1|0|0|0
--   29|resolved_plan_id|TEXT|0|NULL|0|0
--   30|resolved_at|TEXT|0|NULL|0|0
-- card_source_observations: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_transactions|resolved_transaction_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_accounts|currency|currency|NO ACTION|RESTRICT|NONE
--   2|0|card_sync_namespaces|identity_namespace|namespace|NO ACTION|RESTRICT|NONE
--   2|1|card_sync_namespaces|namespace_kind|kind|NO ACTION|RESTRICT|NONE
--   3|0|card_scopes|source_scope_id|id|NO ACTION|RESTRICT|NONE
--   3|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   3|2|card_scopes|source_scope_kind|kind|NO ACTION|RESTRICT|NONE
--   4|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
--   4|1|card_sync_observation_sets|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   5|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
--   5|1|card_sync_observation_sets|origin|origin|NO ACTION|RESTRICT|NONE
-- card_source_observations: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_source_observations_file_open|1|c|1
--     0|3|card_account_id|0|BINARY|1
--     1|6|source_scope_id|0|BINARY|1
--     2|8|identity_namespace|0|BINARY|1
--     3|12|identity_hash|0|BINARY|1
--     4|24|content_digest|0|BINARY|1
--     5|-1|NULL|0|BINARY|0
--   idx_card_source_observations_identity|0|c|0
--     0|3|card_account_id|0|BINARY|1
--     1|6|source_scope_id|0|BINARY|1
--     2|8|identity_namespace|0|BINARY|1
--     3|12|identity_hash|0|BINARY|1
--     4|-1|NULL|0|BINARY|0
--   idx_card_source_observations_ordinal|1|c|0
--     0|1|observation_set_id|0|BINARY|1
--     1|4|ordinal|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_observations_set_state|0|c|0
--     0|1|observation_set_id|0|BINARY|1
--     1|25|state|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_source_observations_txn|0|c|0
--     0|27|resolved_transaction_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_source_observations_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_audit_events: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|event_type|TEXT|1|NULL|0|0
--   2|actor_kind|TEXT|1|NULL|0|0
--   3|actor_ref|TEXT|0|NULL|0|0
--   4|card_account_id|TEXT|0|NULL|0|0
--   5|binding_id|TEXT|0|NULL|0|0
--   6|device_id|TEXT|0|NULL|0|0
--   7|pairing_id|TEXT|0|NULL|0|0
--   8|run_id|TEXT|0|NULL|0|0
--   9|observation_set_id|TEXT|0|NULL|0|0
--   10|plan_id|TEXT|0|NULL|0|0
--   11|ledger_event_id|TEXT|0|NULL|0|0
--   12|code|TEXT|0|NULL|0|0
--   13|version_before|INTEGER|0|NULL|0|0
--   14|version_after|INTEGER|0|NULL|0|0
--   15|row_count|INTEGER|0|NULL|0|0
--   16|byte_count|INTEGER|0|NULL|0|0
--   17|item_count|INTEGER|0|NULL|0|0
--   18|authorization_generation|TEXT|0|NULL|0|0
--   19|created_at|TEXT|1|NULL|0|0
-- card_sync_audit_events: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
-- card_sync_audit_events: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_audit_events_created|0|c|0
--     0|19|created_at|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_audit_events_device|0|c|0
--     0|6|device_id|0|BINARY|1
--     1|19|created_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_audit_events_set|0|c|0
--     0|9|observation_set_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_audit_events_type|0|c|0
--     0|1|event_type|0|BINARY|1
--     1|12|code|0|BINARY|1
--     2|19|created_at|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_audit_events_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_commit_plans: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|plan_kind|TEXT|1|NULL|0|0
--   2|card_account_id|TEXT|1|NULL|0|0
--   3|observation_set_id|TEXT|1|NULL|0|0
--   4|set_version|INTEGER|1|NULL|0|0
--   5|principal_kind|TEXT|1|NULL|0|0
--   6|device_id|TEXT|0|NULL|0|0
--   7|actor_ref|TEXT|0|NULL|0|0
--   8|binding_id|TEXT|0|NULL|0|0
--   9|binding_version|INTEGER|0|NULL|0|0
--   10|payload_digest|TEXT|0|NULL|0|0
--   11|plan_digest|TEXT|1|NULL|0|0
--   12|auto_eligible|INTEGER|1|NULL|0|0
--   13|source_reviewed|INTEGER|1|0|0|0
--   14|action_count|INTEGER|1|NULL|0|0
--   15|count_insert|INTEGER|1|NULL|0|0
--   16|count_update|INTEGER|1|NULL|0|0
--   17|count_unchanged|INTEGER|1|NULL|0|0
--   18|count_aliased|INTEGER|1|NULL|0|0
--   19|count_matched|INTEGER|1|NULL|0|0
--   20|count_attributed|INTEGER|1|NULL|0|0
--   21|count_promoted|INTEGER|1|NULL|0|0
--   22|count_corrected|INTEGER|1|NULL|0|0
--   23|count_rejected|INTEGER|1|NULL|0|0
--   24|count_unmatched|INTEGER|1|NULL|0|0
--   25|count_superseded|INTEGER|1|NULL|0|0
--   26|ledger_revision|INTEGER|1|NULL|0|0
--   27|policy_revision|INTEGER|0|NULL|0|0
--   28|issuer_policy_revision|INTEGER|0|NULL|0|0
--   29|contract_version|INTEGER|0|NULL|0|0
--   30|guard_revision|INTEGER|1|NULL|0|0
--   31|authorization_generation|TEXT|0|NULL|0|0
--   32|created_at|TEXT|1|NULL|0|0
--   33|expires_at|TEXT|1|NULL|0|0
--   34|status|TEXT|1|'prepared'|0|0
--   35|closed_at|TEXT|0|NULL|0|0
--   36|cancel_reason|TEXT|0|NULL|0|0
-- card_sync_commit_plans: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_source_bindings|binding_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_source_bindings|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_sync_observation_sets|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_sync_devices|device_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_commit_plans: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_commit_plans_device|0|c|0
--     0|6|device_id|0|BINARY|1
--     1|34|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_commit_plans_fk_kind|1|c|0
--     0|0|id|0|BINARY|1
--     1|2|card_account_id|0|BINARY|1
--     2|1|plan_kind|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_sync_commit_plans_one_prepared|1|c|1
--     0|3|observation_set_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_commit_plans_set|0|c|0
--     0|3|observation_set_id|0|BINARY|1
--     1|34|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_commit_plans_status|0|c|0
--     0|34|status|0|BINARY|1
--     1|33|expires_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_commit_plans_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_device_scopes: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|device_id|TEXT|1|NULL|0|0
--   2|binding_id|TEXT|1|NULL|0|0
--   3|binding_version|INTEGER|1|NULL|0|0
--   4|mode|TEXT|1|NULL|0|0
--   5|contract_version|INTEGER|1|NULL|0|0
--   6|status|TEXT|1|'active'|0|0
--   7|granted_by_ref|TEXT|1|NULL|0|0
--   8|granted_at|TEXT|1|NULL|0|0
--   9|revoked_at|TEXT|0|NULL|0|0
--   10|auto_sync|INTEGER|1|0|0|0
--   11|consent_contract_version|INTEGER|0|NULL|0|0
--   12|consent_guard_revision|INTEGER|0|NULL|0|0
--   13|consent_issuer_revision|INTEGER|0|NULL|0|0
--   14|consent_binding_version|INTEGER|0|NULL|0|0
--   15|consent_by_ref|TEXT|0|NULL|0|0
--   16|consent_at|TEXT|0|NULL|0|0
-- card_sync_device_scopes: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_source_bindings|binding_id|id|NO ACTION|RESTRICT|NONE
--   1|0|card_sync_devices|device_id|id|NO ACTION|CASCADE|NONE
-- card_sync_device_scopes: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_device_scopes_active|1|c|1
--     0|1|device_id|0|BINARY|1
--     1|2|binding_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_device_scopes_binding|0|c|0
--     0|2|binding_id|0|BINARY|1
--     1|6|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_device_scopes_device|0|c|0
--     0|1|device_id|0|BINARY|1
--     1|6|status|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_device_scopes_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_devices: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|pairing_id|TEXT|1|NULL|0|0
--   2|token_digest|TEXT|0|NULL|0|0
--   3|fingerprint|TEXT|1|NULL|0|0
--   4|label|TEXT|1|NULL|0|0
--   5|client_version|TEXT|1|NULL|0|0
--   6|owner_ref|TEXT|1|NULL|0|0
--   7|status|TEXT|1|'pending'|0|0
--   8|created_at|TEXT|1|NULL|0|0
--   9|pending_expires_at|TEXT|1|NULL|0|0
--   10|activated_at|TEXT|0|NULL|0|0
--   11|activated_by_ref|TEXT|0|NULL|0|0
--   12|expires_at|TEXT|0|NULL|0|0
--   13|closed_at|TEXT|0|NULL|0|0
--   14|close_reason|TEXT|0|NULL|0|0
--   15|authorization_generation|TEXT|1|NULL|0|0
--   16|last_used_at|TEXT|0|NULL|0|0
-- card_sync_devices: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_pairings|pairing_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_devices: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_devices_pairing|1|c|0
--     0|1|pairing_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_devices_status|0|c|0
--     0|7|status|0|BINARY|1
--     1|12|expires_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_devices_token|1|c|1
--     0|2|token_digest|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_devices_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_issuer_policy: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|enabled|INTEGER|1|0|0|0
--   2|enabled_at|TEXT|0|NULL|0|0
--   3|approved_contract_version|INTEGER|0|NULL|0|0
--   4|risk_acknowledged_at|TEXT|0|NULL|0|0
--   5|main_passive_accepted|INTEGER|1|0|0|0
--   6|revision|INTEGER|1|1|0|0
--   7|updated_by_ref|TEXT|0|NULL|0|0
--   8|updated_at|TEXT|1|NULL|0|0
-- card_sync_issuer_policy: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
-- card_sync_issuer_policy: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   sqlite_autoindex_card_sync_issuer_policy_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_namespaces: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|namespace|TEXT|1|NULL|1|0
--   1|kind|TEXT|1|NULL|0|0
--   2|source|TEXT|0|NULL|0|0
--   3|contract_version|INTEGER|0|NULL|0|0
-- card_sync_namespaces: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_sources|source|source|NO ACTION|RESTRICT|NONE
-- card_sync_namespaces: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_namespaces_fk_kind|1|c|0
--     0|0|namespace|0|BINARY|1
--     1|1|kind|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_namespaces_one_capture|1|c|1
--     0|2|source|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_namespaces_source|0|c|0
--     0|2|source|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_namespaces_1|1|pk|0
--     0|0|namespace|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_observation_sets: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|origin|TEXT|1|NULL|0|0
--   2|card_account_id|TEXT|1|NULL|0|0
--   3|issuer|TEXT|1|NULL|0|0
--   4|currency|TEXT|1|NULL|0|0
--   5|run_id|TEXT|0|NULL|0|0
--   6|device_id|TEXT|0|NULL|0|0
--   7|binding_id|TEXT|0|NULL|0|0
--   8|binding_version|INTEGER|0|NULL|0|0
--   9|capture_id|TEXT|0|NULL|0|0
--   10|payload_digest|TEXT|0|NULL|0|0
--   11|contract_version|INTEGER|0|NULL|0|0
--   12|mode|TEXT|0|NULL|0|0
--   13|observed_at|TEXT|0|NULL|0|0
--   14|owner|TEXT|0|NULL|0|0
--   15|import_batch_id|TEXT|0|NULL|0|0
--   16|file_chunk|INTEGER|0|NULL|0|0
--   17|source|TEXT|1|NULL|0|0
--   18|parser_version|TEXT|1|NULL|0|0
--   19|authorization_generation|TEXT|0|NULL|0|0
--   20|guard_revision|INTEGER|1|NULL|0|0
--   21|accepted_at|TEXT|1|NULL|0|0
--   22|expires_at|TEXT|1|NULL|0|0
--   23|state|TEXT|1|NULL|0|0
--   24|version|INTEGER|1|1|0|0
--   25|review_ledger_revision|INTEGER|1|NULL|0|0
--   26|row_count|INTEGER|1|NULL|0|0
--   27|byte_count|INTEGER|1|NULL|0|0
--   28|producer_rejected_count|INTEGER|1|0|0|0
--   29|statement_present|INTEGER|1|0|0|0
--   30|statement_charges_minor|INTEGER|0|NULL|0|0
--   31|statement_credits_minor|INTEGER|0|NULL|0|0
--   32|statement_net_minor|INTEGER|0|NULL|0|0
--   33|statement_previous_balance_minor|INTEGER|0|NULL|0|0
--   34|statement_new_balance_minor|INTEGER|0|NULL|0|0
--   35|open_count|INTEGER|1|0|0|0
--   36|inserted_count|INTEGER|1|0|0|0
--   37|updated_count|INTEGER|1|0|0|0
--   38|matched_count|INTEGER|1|0|0|0
--   39|attributed_count|INTEGER|1|0|0|0
--   40|unchanged_count|INTEGER|1|0|0|0
--   41|rejected_count|INTEGER|1|0|0|0
--   42|expired_count|INTEGER|1|0|0|0
--   43|receipt_state|TEXT|1|NULL|0|0
--   44|closed_at|TEXT|0|NULL|0|0
--   45|close_reason|TEXT|0|NULL|0|0
--   46|discard_reason|TEXT|0|NULL|0|0
--   47|closed_by_ref|TEXT|0|NULL|0|0
--   48|content_purged_at|TEXT|0|NULL|0|0
-- card_sync_observation_sets: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_import_batches|import_batch_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_import_batches|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_sync_sources|source|source|NO ACTION|RESTRICT|NONE
--   1|1|card_sync_sources|issuer|issuer|NO ACTION|RESTRICT|NONE
--   1|2|card_sync_sources|mode|mode|NO ACTION|RESTRICT|NONE
--   2|0|card_source_bindings|binding_id|id|NO ACTION|RESTRICT|NONE
--   2|1|card_source_bindings|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|2|card_source_bindings|source|source|NO ACTION|RESTRICT|NONE
--   3|0|card_sync_runs|run_id|id|NO ACTION|RESTRICT|NONE
--   3|1|card_sync_runs|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   4|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
--   4|1|card_accounts|issuer|issuer|NO ACTION|RESTRICT|NONE
--   4|2|card_accounts|currency|currency|NO ACTION|RESTRICT|NONE
--   5|0|card_sync_devices|device_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_observation_sets: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_observation_sets_account|0|c|0
--     0|2|card_account_id|0|BINARY|1
--     1|23|state|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_batch_chunk|1|c|0
--     0|15|import_batch_id|0|BINARY|1
--     1|16|file_chunk|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_binding|0|c|0
--     0|7|binding_id|0|BINARY|1
--     1|23|state|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_capture|1|c|0
--     0|9|capture_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_device|0|c|0
--     0|6|device_id|0|BINARY|1
--     1|23|state|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|2|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_fk_origin|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|origin|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_run|1|c|0
--     0|5|run_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_observation_sets_state|0|c|0
--     0|23|state|0|BINARY|1
--     1|22|expires_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_observation_sets_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_pairing_scopes: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|pairing_id|TEXT|1|NULL|0|0
--   2|binding_id|TEXT|1|NULL|0|0
--   3|binding_version|INTEGER|1|NULL|0|0
--   4|mode|TEXT|1|NULL|0|0
--   5|contract_version|INTEGER|1|NULL|0|0
-- card_sync_pairing_scopes: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_source_bindings|binding_id|id|NO ACTION|RESTRICT|NONE
--   1|0|card_sync_pairings|pairing_id|id|NO ACTION|CASCADE|NONE
-- card_sync_pairing_scopes: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_pairing_scopes_binding|1|c|0
--     0|1|pairing_id|0|BINARY|1
--     1|2|binding_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_pairing_scopes_binding_id|0|c|0
--     0|2|binding_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_pairing_scopes_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_pairings: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|code_digest|TEXT|0|NULL|0|0
--   2|status|TEXT|1|'open'|0|0
--   3|replaces_device_id|TEXT|0|NULL|0|0
--   4|created_by_ref|TEXT|1|NULL|0|0
--   5|created_at|TEXT|1|NULL|0|0
--   6|expires_at|TEXT|1|NULL|0|0
--   7|failed_attempts|INTEGER|1|0|0|0
--   8|authorization_generation|TEXT|1|NULL|0|0
--   9|redeemed_at|TEXT|0|NULL|0|0
--   10|closed_at|TEXT|0|NULL|0|0
-- card_sync_pairings: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_devices|replaces_device_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_pairings: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_pairings_code|1|c|1
--     0|1|code_digest|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_pairings_one_open|1|c|1
--     0|4|created_by_ref|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_pairings_replaces|0|c|0
--     0|3|replaces_device_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_sync_pairings_status|0|c|0
--     0|2|status|0|BINARY|1
--     1|6|expires_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_pairings_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_payload_receipts: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|observation_set_id|TEXT|1|NULL|1|0
--   1|payload_digest|TEXT|1|NULL|0|0
--   2|canonical_json|TEXT|1|NULL|0|0
--   3|byte_length|INTEGER|1|NULL|0|0
--   4|accepted_at|TEXT|1|NULL|0|0
--   5|expires_at|TEXT|1|NULL|0|0
-- card_sync_payload_receipts: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_payload_receipts: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_payload_receipts_expiry|0|c|0
--     0|5|expires_at|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_payload_receipts_1|1|pk|0
--     0|0|observation_set_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_plan_actions: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|plan_id|TEXT|1|NULL|1|0
--   1|ordinal|INTEGER|1|NULL|2|0
--   2|card_account_id|TEXT|1|NULL|0|0
--   3|plan_kind|TEXT|1|NULL|0|0
--   4|op|TEXT|1|NULL|0|0
--   5|observation_ordinal|INTEGER|0|NULL|0|0
--   6|review_item_id|TEXT|0|NULL|0|0
--   7|content_digest|TEXT|0|NULL|0|0
--   8|transaction_id|TEXT|0|NULL|0|0
--   9|expected_revision|INTEGER|0|NULL|0|0
--   10|new_ref|INTEGER|0|NULL|0|0
--   11|related_transaction_id|TEXT|0|NULL|0|0
--   12|related_revision|INTEGER|0|NULL|0|0
--   13|scope_id|TEXT|0|NULL|0|0
--   14|promote|INTEGER|1|0|0|0
--   15|restore|INTEGER|1|0|0|0
--   16|identity_count|INTEGER|1|0|0|0
--   17|reverses_event_id|TEXT|0|NULL|0|0
-- card_sync_plan_actions: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_scopes|scope_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_transactions|related_transaction_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_transactions|transaction_id|id|NO ACTION|RESTRICT|NONE
--   2|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   3|0|card_sync_commit_plans|plan_id|id|NO ACTION|CASCADE|NONE
--   3|1|card_sync_commit_plans|card_account_id|card_account_id|NO ACTION|CASCADE|NONE
--   3|2|card_sync_commit_plans|plan_kind|plan_kind|NO ACTION|CASCADE|NONE
--   4|0|card_transaction_events|reverses_event_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_plan_actions: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   sqlite_autoindex_card_sync_plan_actions_1|1|pk|0
--     0|0|plan_id|0|BINARY|1
--     1|1|ordinal|0|BINARY|1
--     2|-1|NULL|0|BINARY|0

-- card_sync_policy: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|revision|INTEGER|1|1|0|0
--   2|paused|INTEGER|1|0|0|0
--   3|paused_at|TEXT|0|NULL|0|0
--   4|authorization_generation|TEXT|1|NULL|0|0
--   5|generation_changed_at|TEXT|1|NULL|0|0
--   6|recovery_completed_at|TEXT|0|NULL|0|0
--   7|review_retention_days|INTEGER|1|30|0|0
--   8|receipt_retention_days|INTEGER|1|7|0|0
--   9|max_runs_per_device_day|INTEGER|1|50|0|0
--   10|quota_account_sets|INTEGER|1|100|0|0
--   11|quota_account_rows|INTEGER|1|10000|0|0
--   12|quota_account_bytes|INTEGER|1|10485760|0|0
--   13|quota_device_sets|INTEGER|1|200|0|0
--   14|quota_device_rows|INTEGER|1|20000|0|0
--   15|quota_device_bytes|INTEGER|1|20971520|0|0
--   16|quota_global_sets|INTEGER|1|500|0|0
--   17|quota_global_rows|INTEGER|1|50000|0|0
--   18|quota_global_bytes|INTEGER|1|52428800|0|0
--   19|updated_by_ref|TEXT|0|NULL|0|0
--   20|updated_at|TEXT|1|NULL|0|0
-- card_sync_policy: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
-- card_sync_policy: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   sqlite_autoindex_card_sync_policy_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_runs: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|device_id|TEXT|1|NULL|0|0
--   2|client_run_id|TEXT|1|NULL|0|0
--   3|binding_id|TEXT|1|NULL|0|0
--   4|card_account_id|TEXT|1|NULL|0|0
--   5|binding_version|INTEGER|1|NULL|0|0
--   6|adapter_version|TEXT|1|NULL|0|0
--   7|contract_version|INTEGER|1|NULL|0|0
--   8|run_trigger|TEXT|1|NULL|0|0
--   9|authorization_generation|TEXT|1|NULL|0|0
--   10|created_at|TEXT|1|NULL|0|0
--   11|upload_expires_at|TEXT|1|NULL|0|0
--   12|acceptance_state|TEXT|1|'open'|0|0
--   13|payload_digest|TEXT|0|NULL|0|0
--   14|refusal_code|TEXT|0|NULL|0|0
--   15|accepted_at|TEXT|0|NULL|0|0
--   16|closed_at|TEXT|0|NULL|0|0
--   17|aborted_at|TEXT|0|NULL|0|0
--   18|abort_reason|TEXT|0|NULL|0|0
-- card_sync_runs: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_source_bindings|binding_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_source_bindings|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_sync_devices|device_id|id|NO ACTION|RESTRICT|NONE
-- card_sync_runs: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_runs_binding|0|c|0
--     0|3|binding_id|0|BINARY|1
--     1|10|created_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_runs_client|1|c|0
--     0|1|device_id|0|BINARY|1
--     1|2|client_run_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_runs_device_created|0|c|0
--     0|1|device_id|0|BINARY|1
--     1|10|created_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_runs_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|4|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_runs_open|0|c|1
--     0|11|upload_expires_at|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_runs_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_sync_set_card_hints: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|observation_set_id|TEXT|1|NULL|1|0
--   1|origin|TEXT|1|NULL|0|0
--   2|ordinal|INTEGER|1|NULL|2|0
--   3|last4|TEXT|1|NULL|0|0
-- card_sync_set_card_hints: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|CASCADE|NONE
--   0|1|card_sync_observation_sets|origin|origin|NO ACTION|CASCADE|NONE
-- card_sync_set_card_hints: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_set_card_hints_last4|1|c|0
--     0|0|observation_set_id|0|BINARY|1
--     1|3|last4|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_set_card_hints_1|1|pk|0
--     0|0|observation_set_id|0|BINARY|1
--     1|2|ordinal|0|BINARY|1
--     2|-1|NULL|0|BINARY|0

-- card_sync_sources: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|source|TEXT|1|NULL|1|0
--   1|issuer|TEXT|1|NULL|0|0
--   2|mode|TEXT|1|NULL|0|0
--   3|contract_version|INTEGER|1|NULL|0|0
-- card_sync_sources: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
-- card_sync_sources: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_sync_sources_fk_issuer|1|c|0
--     0|0|source|0|BINARY|1
--     1|1|issuer|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_sync_sources_fk_mode|1|c|0
--     0|0|source|0|BINARY|1
--     1|1|issuer|0|BINARY|1
--     2|2|mode|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_sync_sources_1|1|pk|0
--     0|0|source|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_transaction_events: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|1|NULL|1|0
--   1|card_transaction_id|TEXT|1|NULL|0|0
--   2|card_account_id|TEXT|1|NULL|0|0
--   3|event_type|TEXT|1|NULL|0|0
--   4|transaction_revision|INTEGER|1|NULL|0|0
--   5|origin|TEXT|1|NULL|0|0
--   6|actor_kind|TEXT|1|NULL|0|0
--   7|actor_ref|TEXT|0|NULL|0|0
--   8|import_batch_id|TEXT|0|NULL|0|0
--   9|run_id|TEXT|0|NULL|0|0
--   10|observation_set_id|TEXT|0|NULL|0|0
--   11|observation_id|TEXT|0|NULL|0|0
--   12|identity_id|TEXT|0|NULL|0|0
--   13|plan_id|TEXT|0|NULL|0|0
--   14|plan_digest|TEXT|0|NULL|0|0
--   15|related_transaction_id|TEXT|0|NULL|0|0
--   16|cause_event_id|TEXT|0|NULL|0|0
--   17|reverses_event_id|TEXT|0|NULL|0|0
--   18|reason|TEXT|1|NULL|0|0
--   19|from_status|TEXT|0|NULL|0|0
--   20|to_status|TEXT|0|NULL|0|0
--   21|from_amount_minor|INTEGER|0|NULL|0|0
--   22|to_amount_minor|INTEGER|0|NULL|0|0
--   23|from_transaction_date|TEXT|0|NULL|0|0
--   24|to_transaction_date|TEXT|0|NULL|0|0
--   25|from_posted_date|TEXT|0|NULL|0|0
--   26|to_posted_date|TEXT|0|NULL|0|0
--   27|from_kind|TEXT|0|NULL|0|0
--   28|to_kind|TEXT|0|NULL|0|0
--   29|from_scope_id|TEXT|0|NULL|0|0
--   30|to_scope_id|TEXT|0|NULL|0|0
--   31|from_canonical_id|TEXT|0|NULL|0|0
--   32|to_canonical_id|TEXT|0|NULL|0|0
--   33|edit_fields|INTEGER|1|0|0|0
--   34|edit_resolution|TEXT|0|NULL|0|0
--   35|notify|INTEGER|1|0|0|0
--   36|created_at|TEXT|1|NULL|0|0
-- card_transaction_events: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_transactions|related_transaction_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_transactions|card_transaction_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_transaction_events|reverses_event_id|id|NO ACTION|RESTRICT|NONE
--   3|0|card_transaction_events|cause_event_id|id|NO ACTION|RESTRICT|NONE
--   4|0|card_source_identities|identity_id|id|NO ACTION|RESTRICT|NONE
--   5|0|card_source_observations|observation_id|id|NO ACTION|RESTRICT|NONE
--   6|0|card_sync_observation_sets|observation_set_id|id|NO ACTION|RESTRICT|NONE
--   7|0|card_sync_runs|run_id|id|NO ACTION|RESTRICT|NONE
--   8|0|card_import_batches|import_batch_id|id|NO ACTION|RESTRICT|NONE
-- card_transaction_events: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_transaction_events_account|0|c|0
--     0|2|card_account_id|0|BINARY|1
--     1|36|created_at|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_cause|0|c|0
--     0|16|cause_event_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_history|0|c|0
--     0|1|card_transaction_id|0|BINARY|1
--     1|36|created_at|0|BINARY|1
--     2|0|id|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_identity|0|c|0
--     0|12|identity_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_moved_away|0|c|1
--     0|31|from_canonical_id|0|BINARY|1
--     1|36|created_at|0|BINARY|1
--     2|0|id|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_observation|0|c|0
--     0|11|observation_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_reverses|0|c|0
--     0|17|reverses_event_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_run|0|c|0
--     0|9|run_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_set|0|c|0
--     0|10|observation_set_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transaction_events_txn|0|c|0
--     0|1|card_transaction_id|0|BINARY|1
--     1|4|transaction_revision|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_transaction_events_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- card_transaction_versions: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|card_transaction_id|TEXT|1|NULL|1|0
--   1|revision|INTEGER|1|NULL|2|0
--   2|card_account_id|TEXT|1|NULL|0|0
--   3|status|TEXT|1|NULL|0|0
--   4|transaction_date|TEXT|1|NULL|0|0
--   5|posted_date|TEXT|0|NULL|0|0
--   6|amount_minor|INTEGER|1|NULL|0|0
--   7|original_amount_minor|INTEGER|0|NULL|0|0
--   8|original_currency|TEXT|0|NULL|0|0
--   9|kind|TEXT|1|NULL|0|0
--   10|description|TEXT|1|NULL|0|0
--   11|merchant|TEXT|0|NULL|0|0
--   12|issuer_category|TEXT|0|NULL|0|0
--   13|card_scope_id|TEXT|1|NULL|0|0
--   14|removed_reason|TEXT|0|NULL|0|0
--   15|removed_from_status|TEXT|0|NULL|0|0
--   16|removed_at|TEXT|0|NULL|0|0
--   17|merged_into_id|TEXT|0|NULL|0|0
--   18|dismissed_at|TEXT|0|NULL|0|0
--   19|reversal_snapshot_revision|INTEGER|0|NULL|0|0
--   20|replaced_at|TEXT|1|NULL|0|0
-- card_transaction_versions: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_transactions|card_transaction_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
-- card_transaction_versions: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   sqlite_autoindex_card_transaction_versions_1|1|pk|0
--     0|0|card_transaction_id|0|BINARY|1
--     1|1|revision|0|BINARY|1
--     2|-1|NULL|0|BINARY|0

-- card_transactions: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)
--   0|id|TEXT|0|NULL|1|0
--   1|card_account_id|TEXT|1|NULL|0|0
--   2|source|TEXT|1|NULL|0|0
--   3|external_id_hash|TEXT|0|NULL|0|0
--   4|fingerprint|TEXT|0|NULL|0|0
--   5|transaction_date|TEXT|1|NULL|0|0
--   6|posted_date|TEXT|0|NULL|0|0
--   7|status|TEXT|1|NULL|0|0
--   8|amount_minor|INTEGER|1|NULL|0|0
--   9|currency|TEXT|1|NULL|0|0
--   10|original_amount_minor|INTEGER|0|NULL|0|0
--   11|original_currency|TEXT|0|NULL|0|0
--   12|kind|TEXT|1|NULL|0|0
--   13|description|TEXT|1|NULL|0|0
--   14|merchant|TEXT|0|NULL|0|0
--   15|issuer_category|TEXT|0|NULL|0|0
--   16|user_category|TEXT|0|NULL|0|0
--   17|notes|TEXT|0|NULL|0|0
--   18|import_batch_id|TEXT|0|NULL|0|0
--   19|created_at|TEXT|1|strftime('%Y-%m-%dT%H:%M:%fZ', 'now')|0|0
--   20|updated_at|TEXT|1|strftime('%Y-%m-%dT%H:%M:%fZ', 'now')|0|0
--   21|dismissed_at|TEXT|0|NULL|0|0
--   22|card_scope_id|TEXT|1|NULL|0|0
--   23|revision|INTEGER|1|1|0|0
--   24|first_sync_run_id|TEXT|0|NULL|0|0
--   25|removed_reason|TEXT|0|NULL|0|0
--   26|removed_from_status|TEXT|0|NULL|0|0
--   27|removed_at|TEXT|0|NULL|0|0
--   28|merged_into_id|TEXT|0|NULL|0|0
--   29|reversal_snapshot_revision|INTEGER|0|NULL|0|0
-- card_transactions: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)
--   0|0|card_transactions|merged_into_id|id|NO ACTION|RESTRICT|NONE
--   0|1|card_transactions|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   1|0|card_scopes|card_scope_id|id|NO ACTION|RESTRICT|NONE
--   1|1|card_scopes|card_account_id|card_account_id|NO ACTION|RESTRICT|NONE
--   2|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
--   2|1|card_accounts|currency|currency|NO ACTION|RESTRICT|NONE
--   3|0|card_sync_runs|first_sync_run_id|id|NO ACTION|RESTRICT|NONE
--   4|0|card_import_batches|import_batch_id|id|NO ACTION|RESTRICT|NONE
--   5|0|card_accounts|card_account_id|id|NO ACTION|RESTRICT|NONE
-- card_transactions: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)
--   idx_card_transactions_account_date|0|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|5|transaction_date|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_transactions_amount|0|c|0
--     0|1|card_account_id|0|BINARY|1
--     1|9|currency|0|BINARY|1
--     2|8|amount_minor|0|BINARY|1
--     3|5|transaction_date|0|BINARY|1
--     4|-1|NULL|0|BINARY|0
--   idx_card_transactions_batch|0|c|0
--     0|18|import_batch_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transactions_fk_account|1|c|0
--     0|0|id|0|BINARY|1
--     1|1|card_account_id|0|BINARY|1
--     2|-1|NULL|0|BINARY|0
--   idx_card_transactions_merged|0|c|0
--     0|28|merged_into_id|0|BINARY|1
--     1|27|removed_at|0|BINARY|1
--     2|0|id|0|BINARY|1
--     3|-1|NULL|0|BINARY|0
--   idx_card_transactions_run|0|c|0
--     0|24|first_sync_run_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   idx_card_transactions_scope|0|c|0
--     0|22|card_scope_id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0
--   sqlite_autoindex_card_transactions_1|1|pk|0
--     0|0|id|0|BINARY|1
--     1|-1|NULL|0|BINARY|0

-- user_version 15
